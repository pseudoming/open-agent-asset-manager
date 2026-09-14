import {
    MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
    MAXIMUM_ORDINARY_LOG_RETENTION_DAYS,
    MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
    MINIMUM_ORDINARY_LOG_RETENTION_DAYS,
    type ProtocolDiagnosticsHealthV1,
    type ProtocolDiagnosticV1,
    type ProtocolOrdinaryLogSettingsV1,
    type ProtocolSupportBundleMode,
    type ProtocolSupportBundleReviewV1,
} from "@oaam/app-server-protocol";
import { useCallback, useEffect, useState } from "react";
import type { DesktopPerformanceRecordingSnapshot, OaamDesktopBridge } from "../../../bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../../client";
import {
    type DesktopMessageId,
    type DesktopMessageValues,
    localizedText,
    mergeNonInformationalProtocolDiagnostics,
    nonInformationalProtocolDiagnostics,
    type ProtocolFeedback,
    ProtocolFeedbackNotice,
    protocolFeedback,
    useDesktopPresentation,
} from "../../presentation";
import {
    formatBytes,
    WorkbenchBadge,
    WorkbenchConfirmation,
    WorkbenchIconButton,
    WorkbenchNotice,
    WorkbenchSelect,
    WorkbenchSwitch,
} from "../../ui";
import { HOST_LIFECYCLE_MESSAGES, HOST_STARTUP_MODE_MESSAGES, ordinaryLogStateMessage } from "./diagnostics-presentation";

export interface DiagnosticsWorkspaceProps {
    readonly client: DesktopApplicationClientApi;
    readonly desktopBridge: OaamDesktopBridge;
}

type BusyOperation = "load" | "log_save" | "log_clear" | "support_inspect" | "support_export" | "reindex";

interface DiagnosticsFeedback extends ProtocolFeedback {
    readonly tone: "note" | "danger";
}

function diagnosticsFeedback(
    message: DesktopMessageId,
    tone: DiagnosticsFeedback["tone"],
    diagnostics: readonly ProtocolDiagnosticV1[] = [],
    values?: DesktopMessageValues,
): DiagnosticsFeedback {
    return Object.freeze({
        ...protocolFeedback(localizedText(message, values), nonInformationalProtocolDiagnostics(diagnostics)),
        tone,
    });
}

function retainDiagnostics(
    current: DiagnosticsFeedback | undefined,
    diagnostics: readonly ProtocolDiagnosticV1[],
): DiagnosticsFeedback | undefined {
    const retained = nonInformationalProtocolDiagnostics(diagnostics);
    if (retained.length === 0) return current;
    if (current === undefined) return diagnosticsFeedback("diagnostics.load_attention", "note", retained);
    return Object.freeze({
        ...current,
        diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, retained),
    });
}

function healthTone(status: ProtocolDiagnosticsHealthV1["overallStatus"]): "success" | "warning" | "danger" {
    return status === "healthy" ? "success" : status === "degraded" ? "warning" : "danger";
}

function remainingSeconds(snapshot: DesktopPerformanceRecordingSnapshot, now: number): number {
    if (snapshot.state === "recording") return Math.max(0, Math.ceil((snapshot.deadlineAt - now) / 1000));
    if (snapshot.state === "ready") return Math.max(0, Math.ceil((snapshot.expiresAt - now) / 1000));
    return 0;
}

const SUPPORT_ENTRY_CATEGORY_MESSAGES = Object.freeze({
    adapter_capabilities: "diagnostics.support.category.adapter_capabilities",
    documentation: "diagnostics.support.category.documentation",
    health: "diagnostics.support.category.health",
    local_paths: "diagnostics.support.category.local_paths",
    manifest: "diagnostics.support.category.manifest",
    ordinary_log: "diagnostics.support.category.ordinary_log",
    product: "diagnostics.support.category.product",
} as const satisfies Readonly<Record<ProtocolSupportBundleReviewV1["entries"][number]["category"], DesktopMessageId>>);

export function DiagnosticsWorkspace({ client, desktopBridge }: DiagnosticsWorkspaceProps): React.JSX.Element {
    const { snapshot: presentation, text } = useDesktopPresentation();
    const [health, setHealth] = useState<ProtocolDiagnosticsHealthV1>();
    const [logSettings, setLogSettings] = useState<ProtocolOrdinaryLogSettingsV1>();
    const [logEnabled, setLogEnabled] = useState(true);
    const [retentionDays, setRetentionDays] = useState("7");
    const [maximumMiB, setMaximumMiB] = useState("10");
    const [clearConfirmed, setClearConfirmed] = useState(false);
    const [supportMode, setSupportMode] = useState<ProtocolSupportBundleMode>("standard");
    const [supportReview, setSupportReview] = useState<ProtocolSupportBundleReviewV1>();
    const [supportHashCopyState, setSupportHashCopyState] = useState<
        { readonly hash: string; readonly status: "copied" | "failed" } | undefined
    >();
    const [performance, setPerformance] = useState<DesktopPerformanceRecordingSnapshot>({ state: "idle" });
    const [performanceConfirmed, setPerformanceConfirmed] = useState(false);
    const [clock, setClock] = useState(Date.now());
    const [busy, setBusy] = useState<BusyOperation>();
    const [feedback, setFeedback] = useState<DiagnosticsFeedback>();
    const diagnosticsAvailable = client.supportsOperation("diagnostics.health.get");
    const loggingAvailable = [
        "diagnostics.ordinary_log.settings.get",
        "diagnostics.ordinary_log.settings.replace",
        "diagnostics.ordinary_log.clear",
    ].every((operation) => client.supportsOperation(operation as Parameters<typeof client.supportsOperation>[0]));
    const supportAvailable = ["diagnostics.support_bundle.inspect", "diagnostics.support_bundle.export"].every((operation) =>
        client.supportsOperation(operation as Parameters<typeof client.supportsOperation>[0]),
    );
    const reindexAvailable = client.supportsOperation("asset.reindex");

    const load = useCallback(
        async (preserveFeedback = false): Promise<void> => {
            setBusy("load");
            if (!preserveFeedback) setFeedback(undefined);
            try {
                const [healthResult, settingsResult, performanceSnapshot] = await Promise.all([
                    client.getDiagnosticsHealth(),
                    client.getOrdinaryLogSettings(),
                    desktopBridge.getDesktopPerformanceRecording(),
                ]);
                if (healthResult.status === "failed" || settingsResult.status === "failed") {
                    setFeedback(
                        diagnosticsFeedback(
                            "diagnostics.load_failed",
                            "danger",
                            mergeNonInformationalProtocolDiagnostics(healthResult.diagnostics, settingsResult.diagnostics),
                        ),
                    );
                    return;
                }
                setHealth(healthResult.value);
                setLogSettings(settingsResult.value);
                setLogEnabled(settingsResult.value.enabled);
                setRetentionDays(String(settingsResult.value.retentionDays));
                setMaximumMiB(String(settingsResult.value.maximumBytes / (1024 * 1024)));
                setPerformance(performanceSnapshot);
                setFeedback((current) =>
                    retainDiagnostics(
                        preserveFeedback ? current : undefined,
                        mergeNonInformationalProtocolDiagnostics(healthResult.diagnostics, settingsResult.diagnostics),
                    ),
                );
            } catch {
                setFeedback(diagnosticsFeedback("diagnostics.load_failed", "danger"));
            } finally {
                setBusy(undefined);
            }
        },
        [client, desktopBridge],
    );

    useEffect(() => {
        const unsubscribe = desktopBridge.subscribeDesktopPerformanceRecording(setPerformance);
        if (diagnosticsAvailable && loggingAvailable) void load();
        else {
            void desktopBridge.getDesktopPerformanceRecording().then(setPerformance, () => {
                setFeedback(diagnosticsFeedback("diagnostics.performance.unavailable", "danger"));
            });
        }
        return unsubscribe;
    }, [desktopBridge, diagnosticsAvailable, load, loggingAvailable]);

    useEffect(() => {
        if (performance.state !== "recording" && performance.state !== "ready") return;
        setClock(Date.now());
        const timer = setInterval(() => setClock(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [performance.state]);

    async function saveLogSettings(): Promise<void> {
        const parsedRetention = Number(retentionDays);
        const parsedMaximumBytes = Number(maximumMiB) * 1024 * 1024;
        if (
            !Number.isInteger(parsedRetention) ||
            parsedRetention < MINIMUM_ORDINARY_LOG_RETENTION_DAYS ||
            parsedRetention > MAXIMUM_ORDINARY_LOG_RETENTION_DAYS ||
            !Number.isInteger(parsedMaximumBytes) ||
            parsedMaximumBytes < MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES ||
            parsedMaximumBytes > MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES
        ) {
            setFeedback(diagnosticsFeedback("diagnostics.log.invalid", "danger"));
            return;
        }
        setBusy("log_save");
        setFeedback(undefined);
        try {
            const result = await client.replaceOrdinaryLogSettings({
                enabled: logEnabled,
                retentionDays: parsedRetention,
                maximumBytes: parsedMaximumBytes,
            });
            if (result.status === "failed") {
                setFeedback(diagnosticsFeedback("diagnostics.log.save_failed", "danger", result.diagnostics));
                return;
            }
            setLogSettings(result.value);
            setFeedback(diagnosticsFeedback("diagnostics.log.saved", "note", result.diagnostics));
            await load(true);
        } catch {
            setFeedback(diagnosticsFeedback("diagnostics.log.save_failed", "danger"));
        } finally {
            setBusy(undefined);
        }
    }

    async function clearLog(): Promise<void> {
        if (!clearConfirmed) return;
        setBusy("log_clear");
        setFeedback(undefined);
        try {
            const result = await client.clearOrdinaryLog({ confirmedPermanentRemoval: true });
            if (result.status === "failed") {
                setFeedback(diagnosticsFeedback("diagnostics.log.clear_failed", "danger", result.diagnostics));
                return;
            }
            setLogSettings(result.value.settings);
            setClearConfirmed(false);
            setFeedback(
                diagnosticsFeedback("diagnostics.log.cleared", "note", result.diagnostics, {
                    count: result.value.removedSegmentCount,
                    size: formatBytes(result.value.removedBytes, presentation.resolvedLocale),
                }),
            );
            await load(true);
        } catch {
            setFeedback(diagnosticsFeedback("diagnostics.log.clear_failed", "danger"));
        } finally {
            setBusy(undefined);
        }
    }

    async function inspectSupportBundle(): Promise<void> {
        setBusy("support_inspect");
        setFeedback(undefined);
        setSupportReview(undefined);
        setSupportHashCopyState(undefined);
        try {
            const result = await client.inspectSupportBundle({ mode: supportMode });
            if (result.status === "failed") {
                setFeedback(diagnosticsFeedback("diagnostics.support.inspect_failed", "danger", result.diagnostics));
                return;
            }
            setSupportReview(result.value);
            setFeedback(diagnosticsFeedback("diagnostics.support.review_ready", "note", result.diagnostics));
        } catch {
            setFeedback(diagnosticsFeedback("diagnostics.support.inspect_failed", "danger"));
        } finally {
            setBusy(undefined);
        }
    }

    async function copySupportArchiveHash(hash: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(hash);
            setSupportHashCopyState({ hash, status: "copied" });
        } catch {
            setSupportHashCopyState({ hash, status: "failed" });
        }
    }

    async function exportSupportBundle(): Promise<void> {
        if (supportReview === undefined) return;
        setBusy("support_export");
        setFeedback(undefined);
        try {
            const picker = await desktopBridge.pickSupportBundleExport(`oaam-support-${supportReview.createdAt}.zip`);
            if (picker.status === "cancelled") return;
            const result = await client.exportSupportBundle({
                supportBundleReviewToken: supportReview.supportBundleReviewToken,
                localPathSelectionToken: picker.localPathSelectionToken,
                userActionId: globalThis.crypto.randomUUID(),
            });
            if (result.status === "failed") {
                setFeedback(diagnosticsFeedback("diagnostics.support.export_failed", "danger", result.diagnostics));
                return;
            }
            setSupportReview(undefined);
            setFeedback(
                diagnosticsFeedback("diagnostics.support.exported", "note", result.diagnostics, {
                    path: picker.displayPath,
                }),
            );
        } catch {
            setFeedback(diagnosticsFeedback("diagnostics.support.export_failed", "danger"));
        } finally {
            setBusy(undefined);
        }
    }

    async function startPerformanceRecording(): Promise<void> {
        if (!performanceConfirmed) return;
        setPerformanceConfirmed(false);
        try {
            setPerformance(await desktopBridge.startDesktopPerformanceRecording(true));
        } catch {
            setFeedback(diagnosticsFeedback("diagnostics.performance.start_failed", "danger"));
        }
    }

    async function runPerformanceAction(action: "stop" | "save" | "discard"): Promise<void> {
        try {
            if (action === "stop") setPerformance(await desktopBridge.stopDesktopPerformanceRecording());
            else if (action === "discard") setPerformance(await desktopBridge.discardDesktopPerformanceRecording());
            else {
                const result = await desktopBridge.saveDesktopPerformanceRecording();
                if (result.status === "complete") {
                    setFeedback(
                        diagnosticsFeedback("diagnostics.performance.saved", "note", [], {
                            path: result.displayPath,
                        }),
                    );
                    setPerformance(await desktopBridge.getDesktopPerformanceRecording());
                } else if (result.status === "failed") throw new Error(result.code);
            }
        } catch {
            setFeedback(diagnosticsFeedback(`diagnostics.performance.${action}_failed`, "danger"));
        }
    }

    async function reindex(): Promise<void> {
        setBusy("reindex");
        setFeedback(undefined);
        try {
            const result = await client.reindexAssets({});
            if (result.status === "failed") {
                setFeedback(diagnosticsFeedback("diagnostics.reindex.failed", "danger", result.diagnostics));
                return;
            }
            setFeedback(
                diagnosticsFeedback(
                    "diagnostics.reindex.complete",
                    "note",
                    mergeNonInformationalProtocolDiagnostics(result.diagnostics, result.value.diagnostics),
                    {
                        indexed: result.value.indexedAssets,
                        skipped: result.value.skippedAssets,
                    },
                ),
            );
        } catch {
            setFeedback(diagnosticsFeedback("diagnostics.reindex.failed", "danger"));
        } finally {
            setBusy(undefined);
        }
    }

    const ordinaryLogHealth = health === undefined ? undefined : ordinaryLogStateMessage(health.ordinaryLog);

    const feedbackId = feedback?.message.kind === "localized" ? feedback.message.id : "";
    const feedbackSection = feedbackId.startsWith("diagnostics.log.")
        ? "log"
        : feedbackId.startsWith("diagnostics.support.")
          ? "support"
          : feedbackId.startsWith("diagnostics.performance.")
            ? "performance"
            : feedbackId.startsWith("diagnostics.reindex.")
              ? "reindex"
              : "load";
    const feedbackFor = (section: typeof feedbackSection): React.JSX.Element | null =>
        feedback === undefined || feedbackSection !== section ? null : <ProtocolFeedbackNotice {...feedback} />;

    return (
        <div
            className="diagnostics-workspace"
            aria-busy={busy !== undefined}
            data-oaam-diagnostics-state={busy !== undefined ? "busy" : health === undefined ? "loading" : "ready"}
            data-oaam-health-status={health?.overallStatus ?? "unknown"}
            data-oaam-support-review={supportReview === undefined ? "none" : "ready"}
        >
            <div className="settings-section-heading">
                <p>{text("diagnostics.copy")}</p>
            </div>

            {feedbackFor("load")}

            <section className="diagnostics-group">
                <div className="diagnostics-heading-line">
                    <div>
                        <h3>{text("diagnostics.health.title")}</h3>
                        <p>{text("diagnostics.health.copy")}</p>
                    </div>
                    {health === undefined ? null : (
                        <WorkbenchBadge tone={healthTone(health.overallStatus)}>
                            {text(`diagnostics.health.${health.overallStatus}`)}
                        </WorkbenchBadge>
                    )}
                </div>
                {health === undefined ? (
                    <p>{text(diagnosticsAvailable ? "diagnostics.health.loading" : "diagnostics.unavailable")}</p>
                ) : (
                    <dl className="diagnostics-facts">
                        <div>
                            <dt>{text("diagnostics.health.host")}</dt>
                            <dd>{text(HOST_LIFECYCLE_MESSAGES[health.host.lifecycleState])}</dd>
                        </div>
                        <div>
                            <dt>{text("diagnostics.health.startup")}</dt>
                            <dd>{text(HOST_STARTUP_MODE_MESSAGES[health.host.startupMode])}</dd>
                        </div>
                        <div>
                            <dt>{text("diagnostics.health.log")}</dt>
                            <dd>
                                {ordinaryLogHealth === undefined ? null : text(ordinaryLogHealth.state)}
                                {ordinaryLogHealth?.reason === undefined ? null : <small>{text(ordinaryLogHealth.reason)}</small>}
                            </dd>
                        </div>
                        <div>
                            <dt>{text("diagnostics.health.retained")}</dt>
                            <dd>{formatBytes(health.ordinaryLog.retainedBytes, presentation.resolvedLocale)}</dd>
                        </div>
                    </dl>
                )}
                <button
                    data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.001"
                    type="button"
                    className="library-secondary-button"
                    disabled={busy !== undefined}
                    onClick={() => void load()}
                >
                    {text("diagnostics.refresh")}
                </button>
            </section>

            <section className="diagnostics-group">
                <div>
                    <h3>{text("diagnostics.log.title")}</h3>
                    <p>{text("diagnostics.log.copy")}</p>
                </div>
                <div className="diagnostics-form-grid">
                    <WorkbenchSwitch
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.002"
                        checked={logEnabled}
                        label={text("diagnostics.log.enabled")}
                        disabled={!loggingAvailable || busy !== undefined}
                        onCheckedChange={setLogEnabled}
                    />
                    <label>
                        <span>{text("diagnostics.log.retention_days")}</span>
                        <input
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.003"
                            type="number"
                            min={MINIMUM_ORDINARY_LOG_RETENTION_DAYS}
                            max={MAXIMUM_ORDINARY_LOG_RETENTION_DAYS}
                            value={retentionDays}
                            onChange={(event) => setRetentionDays(event.currentTarget.value)}
                        />
                    </label>
                    <label>
                        <span>{text("diagnostics.log.maximum_mib")}</span>
                        <input
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.004"
                            type="number"
                            min={MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES / (1024 * 1024)}
                            max={MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES / (1024 * 1024)}
                            step="0.0625"
                            value={maximumMiB}
                            onChange={(event) => setMaximumMiB(event.currentTarget.value)}
                        />
                    </label>
                </div>
                <div className="diagnostics-actions">
                    <button
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.005"
                        type="button"
                        className="library-secondary-button"
                        disabled={!loggingAvailable || busy !== undefined}
                        onClick={() => void saveLogSettings()}
                    >
                        {text("diagnostics.log.save")}
                    </button>
                </div>
                <div className="diagnostics-actions diagnostics-destructive-action">
                    <WorkbenchConfirmation
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.006"
                        checked={clearConfirmed}
                        disabled={!loggingAvailable || busy !== undefined}
                        onCheckedChange={setClearConfirmed}
                    >
                        {text("diagnostics.log.clear_confirm")}
                    </WorkbenchConfirmation>
                    <button
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.007"
                        type="button"
                        data-oaam-journey-action="diagnostics.log_clear"
                        className="diagnostics-danger-button"
                        disabled={!loggingAvailable || busy !== undefined || !clearConfirmed}
                        onClick={() => void clearLog()}
                    >
                        {text("diagnostics.log.clear")}
                    </button>
                </div>
                {logSettings === undefined ? null : (
                    <small>{text(logSettings.enabled ? "diagnostics.log.active" : "diagnostics.log.disabled")}</small>
                )}
                {feedbackFor("log")}
            </section>

            <section className="diagnostics-group">
                <div>
                    <h3>{text("diagnostics.support.title")}</h3>
                    <p>{text("diagnostics.support.copy")}</p>
                </div>
                <div className="diagnostics-actions">
                    <div className="diagnostics-select-field">
                        <span>{text("diagnostics.support.mode")}</span>
                        <WorkbenchSelect
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.008"
                            label={text("diagnostics.support.mode")}
                            value={supportMode}
                            disabled={!supportAvailable || busy !== undefined}
                            options={[
                                { value: "standard", label: text("diagnostics.support.standard") },
                                { value: "extended", label: text("diagnostics.support.extended") },
                            ]}
                            onChange={(value) => {
                                setSupportMode(value as ProtocolSupportBundleMode);
                                setSupportReview(undefined);
                                setSupportHashCopyState(undefined);
                            }}
                        />
                    </div>
                    <button
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.009"
                        type="button"
                        data-oaam-diagnostics-action="support.inspect"
                        className="library-secondary-button"
                        disabled={!supportAvailable || busy !== undefined}
                        onClick={() => void inspectSupportBundle()}
                    >
                        {text("diagnostics.support.inspect")}
                    </button>
                    <button
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.010"
                        type="button"
                        data-oaam-journey-action="diagnostics.support_export"
                        className="library-primary-button"
                        disabled={supportReview === undefined || busy !== undefined}
                        onClick={() => void exportSupportBundle()}
                    >
                        {text("diagnostics.support.export")}
                    </button>
                </div>
                {supportReview === undefined ? null : (
                    <div className="diagnostics-support-review">
                        <strong>
                            {text("diagnostics.support.review", {
                                count: supportReview.entries.length,
                                size: formatBytes(supportReview.archiveByteLength, presentation.resolvedLocale),
                            })}
                        </strong>
                        <dl className="diagnostics-facts">
                            <div>
                                <dt>{text("diagnostics.support.archive_hash")}</dt>
                                <dd className="diagnostics-support-hash">
                                    <code data-oaam-support-archive-hash>{supportReview.archiveContentHash}</code>
                                    <WorkbenchIconButton
                                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.021"
                                        data-oaam-support-hash-copy={
                                            supportHashCopyState?.hash === supportReview.archiveContentHash
                                                ? supportHashCopyState.status
                                                : "idle"
                                        }
                                        icon="copy"
                                        label={text(
                                            supportHashCopyState?.hash === supportReview.archiveContentHash
                                                ? supportHashCopyState.status === "copied"
                                                    ? "diagnostics.support.hash_copied"
                                                    : "diagnostics.support.hash_copy_failed"
                                                : "diagnostics.support.hash_copy",
                                        )}
                                        onClick={() => void copySupportArchiveHash(supportReview.archiveContentHash)}
                                    />
                                    {supportHashCopyState?.hash === supportReview.archiveContentHash ? (
                                        <small
                                            className="diagnostics-support-hash-feedback"
                                            role="status"
                                            aria-live="polite"
                                            data-oaam-support-hash-feedback={supportHashCopyState.status}
                                        >
                                            {text(
                                                supportHashCopyState.status === "copied"
                                                    ? "diagnostics.support.hash_copied"
                                                    : "diagnostics.support.hash_copy_failed",
                                            )}
                                        </small>
                                    ) : null}
                                </dd>
                            </div>
                            <div>
                                <dt>{text("diagnostics.health.log")}</dt>
                                <dd data-oaam-support-ordinary-log>
                                    {text("diagnostics.support.log_summary", {
                                        includedSegments: supportReview.ordinaryLog.includedSegmentCount,
                                        retainedSegments: supportReview.ordinaryLog.retainedSegmentCount,
                                        includedSize: formatBytes(
                                            supportReview.ordinaryLog.includedBytes,
                                            presentation.resolvedLocale,
                                        ),
                                        retainedSize: formatBytes(
                                            supportReview.ordinaryLog.retainedBytes,
                                            presentation.resolvedLocale,
                                        ),
                                    })}{" "}
                                    {text(
                                        supportReview.ordinaryLog.truncated
                                            ? "diagnostics.support.log_truncated"
                                            : "diagnostics.support.log_full",
                                    )}
                                </dd>
                            </div>
                        </dl>
                        <ul>
                            {supportReview.entries.map((entry) => (
                                <li key={entry.archivePath}>
                                    <span>
                                        <strong>{text(SUPPORT_ENTRY_CATEGORY_MESSAGES[entry.category])}</strong>
                                        <code>{entry.archivePath}</code>
                                    </span>
                                    <span>
                                        {text("diagnostics.support.entry_size", {
                                            size: formatBytes(entry.byteLength, presentation.resolvedLocale),
                                        })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {busy === "support_inspect" || busy === "support_export" ? (
                    <p className="workbench-status-copy" role="status" aria-busy="true">
                        {text(busy === "support_inspect" ? "diagnostics.support.inspect" : "diagnostics.support.export")}…
                    </p>
                ) : null}
                {feedbackFor("support")}
            </section>

            <section className="diagnostics-group">
                <div>
                    <h3>{text("diagnostics.performance.title")}</h3>
                    <p>{text("diagnostics.performance.copy")}</p>
                </div>
                <p className="diagnostics-privacy-copy">{text("diagnostics.performance.warning")}</p>
                {performance.state === "idle" ? (
                    <div className="diagnostics-actions">
                        <WorkbenchConfirmation
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.011"
                            checked={performanceConfirmed}
                            onCheckedChange={setPerformanceConfirmed}
                        >
                            {text("diagnostics.performance.confirm")}
                        </WorkbenchConfirmation>
                        <button
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.012"
                            type="button"
                            data-oaam-journey-action="diagnostics.performance_start"
                            className="library-primary-button"
                            disabled={!performanceConfirmed}
                            onClick={() => void startPerformanceRecording()}
                        >
                            {text("diagnostics.performance.start")}
                        </button>
                    </div>
                ) : performance.state === "recording" ? (
                    <div className="diagnostics-actions">
                        <WorkbenchBadge tone="warning">{text("diagnostics.performance.recording")}</WorkbenchBadge>
                        <span>
                            {text("diagnostics.performance.remaining", { seconds: remainingSeconds(performance, clock) })}
                        </span>
                        <button
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.013"
                            type="button"
                            className="library-secondary-button"
                            onClick={() => void runPerformanceAction("stop")}
                        >
                            {text("diagnostics.performance.stop")}
                        </button>
                    </div>
                ) : performance.state === "ready" ? (
                    <div className="diagnostics-actions">
                        <span>
                            {text("diagnostics.performance.ready", {
                                size: formatBytes(performance.byteSize, presentation.resolvedLocale),
                                seconds: remainingSeconds(performance, clock),
                            })}
                        </span>
                        <button
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.014"
                            type="button"
                            data-oaam-journey-action="diagnostics.performance_save"
                            className="library-primary-button"
                            onClick={() => void runPerformanceAction("save")}
                        >
                            {text("diagnostics.performance.save")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.015"
                            type="button"
                            className="library-secondary-button"
                            onClick={() => void runPerformanceAction("discard")}
                        >
                            {text("diagnostics.performance.discard")}
                        </button>
                    </div>
                ) : (
                    <WorkbenchNotice tone="danger">
                        {text(`diagnostics.performance.failure.${performance.code}`)}
                        {performance.mayStillBeRecording ? ` ${text("diagnostics.performance.retry_stop")}` : ""}
                    </WorkbenchNotice>
                )}
                {performance.state === "failed" ? (
                    <div className="diagnostics-actions">
                        {performance.mayStillBeRecording ? (
                            <button
                                data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.016"
                                type="button"
                                className="library-secondary-button"
                                onClick={() => void runPerformanceAction("stop")}
                            >
                                {text("diagnostics.performance.stop")}
                            </button>
                        ) : null}
                        <button
                            data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.017"
                            type="button"
                            className="library-secondary-button"
                            onClick={() => void runPerformanceAction("discard")}
                        >
                            {text("diagnostics.performance.discard")}
                        </button>
                    </div>
                ) : null}
                {feedbackFor("performance")}
            </section>

            <section className="diagnostics-group">
                <div>
                    <h3>{text("diagnostics.reindex.title")}</h3>
                    <p>{text("diagnostics.reindex.copy")}</p>
                </div>
                <button
                    data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.018"
                    type="button"
                    className="library-secondary-button"
                    disabled={!reindexAvailable || busy !== undefined}
                    onClick={() => void reindex()}
                >
                    {text("diagnostics.reindex.action")}
                </button>
                {feedbackFor("reindex")}
            </section>

            <section className="diagnostics-group">
                <div>
                    <h3>{text("diagnostics.recovery.title")}</h3>
                    <p>{text("diagnostics.recovery.copy")}</p>
                </div>
                <div className="diagnostics-actions">
                    <a
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.019"
                        className="library-secondary-button"
                        href="#state-resilience-settings"
                    >
                        {text("diagnostics.recovery.state")}
                    </a>
                    <a
                        data-oaam-interaction-entry="features.diagnostics.diagnostics_workspace.020"
                        className="library-secondary-button"
                        href="#desktop-maintenance-settings"
                    >
                        {text("diagnostics.recovery.maintenance")}
                    </a>
                </div>
            </section>
        </div>
    );
}
