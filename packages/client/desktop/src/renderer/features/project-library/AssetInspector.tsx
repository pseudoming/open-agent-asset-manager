import { projectDisplayName } from "../../presentation/project-label";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetVersionExportKind, AssetVersionExportPickerResult } from "../../../bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopMessageId, ProtocolDiagnostics, ProtocolFeedbackNotice, useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton, WorkbenchNotice, WorkbenchPressedFilter, WorkbenchSelect, WorkbenchTechnicalFact } from "../../ui";
import { AssetFilePreview, presentAssetFilePath } from "../asset-content-preview";
import { AssetActions, type AssetCopyResult, type AssetLifecycleFeedback } from "./AssetActions";
import { AssetAuthorizations } from "./AssetAuthorizations";
import { AssetDiffView } from "./AssetDiffView";
import { AssetInspectorController, type AssetInspectorState } from "./asset-inspector-controller";
import type { ProjectView } from "./project-library-model";

export interface AssetInspectorProps {
    readonly client: DesktopApplicationClientApi;
    readonly assetId: string;
    readonly initialVersionId?: string;
    readonly projects: readonly ProjectView[];
    readonly pickAssetVersionExport: (
        exportKind: AssetVersionExportKind,
        suggestedFileName: string,
    ) => Promise<AssetVersionExportPickerResult>;
    readonly onLibraryChanged: () => void;
    readonly onCopyCreated?: (copy: AssetCopyResult) => void;
    readonly onOpenCopy?: (copy: AssetCopyResult) => void;
    readonly onPurged: (feedback: AssetLifecycleFeedback) => void;
    readonly onAddToTool?: () => void;
    readonly initialAction?: "metadata" | "copy";
    readonly onClose: () => void;
}

function parentDirectory(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
}

function exportFileName(displayName: string, revision: number, exportKind: AssetVersionExportKind): string {
    const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
    const safe = [...displayName]
        .map((character) => {
            const code = character.codePointAt(0) ?? 0;
            return forbidden.has(character) || code < 32 ? "_" : character;
        })
        .join("")
        .trim()
        .slice(0, 80);
    const suffix = exportKind === "native_files" ? "original-files" : "oaam-version";
    return `${safe === "" ? "asset" : safe}-revision-${revision}-${suffix}.zip`;
}

function comparisonStageMessage(stage: string | undefined): DesktopMessageId {
    switch (stage) {
        case "inventory":
            return "library.compare.stage.inventory";
        case "loading":
            return "library.compare.stage.loading";
        case "diffing":
            return "library.compare.stage.diffing";
        default:
            return "library.compare.stage.starting";
    }
}

const FILE_CONTENT_KIND_MESSAGES = {
    binary: "library.files.kind.binary",
    text: "library.files.kind.text",
} as const satisfies Record<"binary" | "text", DesktopMessageId>;

type AssetInspectorView = "metadata" | "preview" | "authorizations";

export function AssetInspector({
    client,
    assetId,
    initialVersionId,
    projects,
    pickAssetVersionExport,
    onLibraryChanged,
    onCopyCreated,
    onOpenCopy,
    onPurged,
    onAddToTool,
    initialAction,
    onClose,
}: AssetInspectorProps): React.JSX.Element {
    const { snapshot, text, displayText } = useDesktopPresentation();
    const controller = useMemo(() => new AssetInspectorController(client), [client]);
    const [state, setState] = useState<AssetInspectorState>(controller.state);
    const [comparisonVersionId, setComparisonVersionId] = useState("");
    const [diffMode, setDiffMode] = useState<"unified" | "side_by_side">("unified");
    const [pickerMessage, setPickerMessage] = useState<string>();
    const [inspectorView, setInspectorView] = useState<AssetInspectorView>("metadata");
    const initialActionConsumed = useRef(false);
    const comparisonSectionRef = useRef<HTMLElement>(null);
    const comparisonStatus = state.status === "ready" ? state.comparison.status : "none";
    const versions = state.status === "ready" ? state.versions : undefined;
    const selectedVersionId = state.status === "ready" ? state.selectedVersion.versionId : undefined;
    const automaticPreviewPath =
        state.status === "ready" && state.preview.status === "none"
            ? state.files.find((entry) => entry.entryKind === "file")?.file.logicalPath
            : undefined;

    useEffect(() => {
        setInspectorView("metadata");
        const unsubscribe = controller.subscribe(setState);
        void controller.load(assetId, initialVersionId);
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [assetId, initialVersionId, controller]);

    useEffect(() => {
        if (versions === undefined || selectedVersionId === undefined) return;
        const candidate = versions.find((version) => version.versionId !== selectedVersionId);
        setComparisonVersionId(candidate?.versionId ?? "");
    }, [selectedVersionId, versions]);

    useEffect(() => {
        if (automaticPreviewPath !== undefined) void controller.selectFile(automaticPreviewPath);
    }, [automaticPreviewPath, controller]);

    useEffect(() => {
        if (comparisonStatus === "running" || comparisonStatus === "ready" || comparisonStatus === "failed") {
            comparisonSectionRef.current?.scrollIntoView?.({ block: "start", inline: "nearest" });
        }
    }, [comparisonStatus]);

    const formatDate = (value: number): string =>
        new Intl.DateTimeFormat(snapshot.resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(value);

    async function exportVersion(exportKind: AssetVersionExportKind): Promise<void> {
        if (state.status !== "ready") return;
        setPickerMessage(undefined);
        try {
            const selection = await pickAssetVersionExport(
                exportKind,
                exportFileName(state.asset.displayName, state.selectedVersion.revision, exportKind),
            );
            if (selection.status !== "selected") return;
            await controller.exportSelected(exportKind, selection.localPathSelectionToken, globalThis.crypto.randomUUID());
        } catch {
            setPickerMessage(text(exportKind === "native_files" ? "library.native_export.failed" : "library.export.failed"));
        }
    }

    function selectPreviewFile(logicalPath: string): void {
        setInspectorView("preview");
        void controller.selectFile(logicalPath);
    }

    const markInitialActionConsumed = useCallback(() => {
        initialActionConsumed.current = true;
    }, []);

    return (
        <aside
            className="asset-inspector"
            data-oaam-asset-id={state.status === "ready" ? state.asset.assetId : undefined}
            data-oaam-state={state.status}
            data-oaam-asset-deleted={state.status === "ready" ? state.asset.deleted : undefined}
            data-oaam-version-count={state.status === "ready" ? state.versions.length : undefined}
            aria-label={text("library.inspector.label")}
        >
            <header className="asset-inspector-header">
                <div>
                    <span>{text("library.inspector.eyebrow")}</span>
                    <h2>{state.status === "ready" ? state.asset.displayName : text("library.inspector.title")}</h2>
                    {state.status === "ready" && state.asset.deleted ? (
                        <p className="asset-inspector-deleted">{text("library.assets.deleted")}</p>
                    ) : null}
                </div>
                {state.status === "ready" ? (
                    <nav className="asset-inspector-modes" aria-label={text("library.inspector.views")}>
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_inspector.001"
                            type="button"
                            aria-pressed={inspectorView === "metadata"}
                            onClick={() => setInspectorView("metadata")}
                        >
                            {text("library.inspector.metadata")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_inspector.002"
                            type="button"
                            aria-pressed={inspectorView === "preview"}
                            disabled={state.preview.status === "none" && automaticPreviewPath === undefined}
                            onClick={() => setInspectorView("preview")}
                        >
                            {text("library.preview.title")}
                        </button>
                        <WorkbenchPressedFilter
                            data-oaam-interaction-entry="features.project-library.asset_inspector.021"
                            pressed={inspectorView === "authorizations"}
                            onClick={() => setInspectorView("authorizations")}
                        >
                            {text("library.grants.title")}
                        </WorkbenchPressedFilter>
                    </nav>
                ) : null}
                <WorkbenchIconButton
                    data-oaam-interaction-entry="features.project-library.asset_inspector.003"
                    className="library-icon-button"
                    icon="close"
                    label={text("library.inspector.close")}
                    onClick={onClose}
                />
            </header>
            {state.status === "none" || state.status === "loading" ? (
                <WorkbenchNotice className="inspector-status" aria-busy="true" role="status">
                    {text("library.inspector.loading")}
                </WorkbenchNotice>
            ) : state.status === "failed" ? (
                <div
                    data-oaam-visible-state="asset_inspector_unavailable"
                    data-oaam-state-presentation="action_required"
                    data-oaam-state-blocking-scope="current_inspector"
                    data-oaam-state-persistence="transient"
                >
                    <WorkbenchNotice className="inspector-status" tone="danger" role="alert">
                        {displayText(state.message)}
                    </WorkbenchNotice>
                    <ProtocolDiagnostics diagnostics={state.diagnostics} technicalSummary={text("import.ui.technical_details")} />
                    <div className="status-card-actions">
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_inspector.020"
                            data-oaam-visible-state-action="retry_asset_inspector"
                            type="button"
                            onClick={() => void controller.load(assetId, initialVersionId)}
                        >
                            {text("common.retry")}
                        </button>
                    </div>
                </div>
            ) : inspectorView === "authorizations" ? (
                <AssetAuthorizations key={assetId} client={client} assetId={assetId} />
            ) : inspectorView === "preview" ? (
                <div className="asset-inspector-preview-pane">
                    <ProtocolDiagnostics diagnostics={state.diagnostics} technicalSummary={text("import.ui.technical_details")} />
                    <AssetFilePreview
                        key={`${state.selectedVersion.versionId}:${state.preview.status === "none" ? "none" : state.preview.logicalPath}`}
                        preview={state.preview}
                        versionLabel={text("library.assets.revision", { revision: state.selectedVersion.revision })}
                        displayPath={
                            state.preview.status === "none"
                                ? undefined
                                : presentAssetFilePath(state.asset, state.preview.logicalPath)
                        }
                        onLoadMoreText={() => void controller.loadMoreText()}
                    />
                </div>
            ) : (
                <div className="asset-inspector-scroll">
                    <ProtocolDiagnostics diagnostics={state.diagnostics} technicalSummary={text("import.ui.technical_details")} />
                    <AssetActions
                        client={client}
                        asset={state.asset}
                        selectedVersion={state.selectedVersion}
                        projects={projects}
                        initialMode={initialActionConsumed.current ? undefined : initialAction}
                        onInitialModeConsumed={markInitialActionConsumed}
                        onAddToTool={onAddToTool}
                        onAssetChanged={(asset) => {
                            controller.replaceAsset(asset);
                            onLibraryChanged();
                        }}
                        onCopyCreated={onCopyCreated ?? onLibraryChanged}
                        onOpenCopy={onOpenCopy}
                        onPurged={onPurged}
                    />
                    <section className="inspector-section">
                        <h3>{text("library.inspector.overview")}</h3>
                        {state.asset.displayDescription ? <p>{state.asset.displayDescription}</p> : null}
                        <dl className="inspector-facts">
                            <div>
                                <dt>{text("library.inspector.kind")}</dt>
                                <dd>{state.asset.kind}</dd>
                            </div>
                            <div>
                                <dt>{text("library.inspector.scope")}</dt>
                                <dd>{text(`import.ui.asset.scope.${state.asset.scope}`)}</dd>
                            </div>
                            {state.asset.projectId === undefined ? null : (
                                <div>
                                    <dt>{text("library.inspector.project")}</dt>
                                    <dd>
                                        {projectDisplayName(
                                            projects.find((project) => project.projectId === state.asset.projectId),
                                        ) ?? text("library.inspector.project_unavailable")}
                                    </dd>
                                </div>
                            )}
                            {state.asset.scopePath ? (
                                <div>
                                    <dt>{text("library.inspector.scope_path")}</dt>
                                    <dd>
                                        <code>{state.asset.scopePath}</code>
                                    </dd>
                                </div>
                            ) : null}
                            <div>
                                <dt>{text("library.inspector.updated")}</dt>
                                <dd className="inspector-fact-value">
                                    <WorkbenchTechnicalFact
                                        data-oaam-interaction-entry="features.project-library.asset_inspector.004"
                                        fact={<span>{formatDate(state.asset.updatedAt)}</span>}
                                        summary={text("import.ui.technical_details")}
                                    >
                                        <code>{text("import.ui.technical.asset_id", { assetId: state.asset.assetId })}</code>
                                        {state.asset.projectId === undefined ? null : (
                                            <code>
                                                {text("library.inspector.project_id", {
                                                    projectId: state.asset.projectId,
                                                })}
                                            </code>
                                        )}
                                    </WorkbenchTechnicalFact>
                                </dd>
                            </div>
                        </dl>
                    </section>

                    <section className="inspector-section">
                        <h3>{text("library.inspector.versions")}</h3>
                        <div className="inspector-select-field inspector-version-picker">
                            <WorkbenchTechnicalFact
                                data-oaam-interaction-entry="features.project-library.asset_inspector.007"
                                fact={<span>{text("library.inspector.version_select")}</span>}
                                summary={text("import.ui.technical_details")}
                            >
                                <code>
                                    {text("import.ui.technical.version_id", { versionId: state.selectedVersion.versionId })}
                                </code>
                                <code>
                                    {text("library.inspector.fingerprint_value", {
                                        fingerprint: state.selectedVersion.fingerprint,
                                    })}
                                </code>
                            </WorkbenchTechnicalFact>
                            <WorkbenchSelect
                                data-oaam-interaction-entry="features.project-library.asset_inspector.005"
                                label={text("library.inspector.version_select")}
                                value={state.selectedVersion.versionId}
                                options={state.versions.map((version) => ({
                                    value: version.versionId,
                                    label: `${text("library.assets.revision", { revision: version.revision })} · ${formatDate(
                                        version.createdAt,
                                    )}`,
                                }))}
                                onChange={(value) => void controller.selectVersion(value)}
                            />
                        </div>
                        {state.versionsHaveMore ? (
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_inspector.006"
                                type="button"
                                className="library-secondary-button"
                                onClick={() => void controller.loadMoreVersions()}
                            >
                                {text("library.inspector.more_versions")}
                            </button>
                        ) : null}
                        {state.selectedVersion.status === "incomplete" ? (
                            <WorkbenchNotice tone="warning">{text("library.inspector.incomplete")}</WorkbenchNotice>
                        ) : null}
                        <div className="detail-actions">
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_inspector.008"
                                type="button"
                                data-oaam-action="export-native-files"
                                onClick={() => void exportVersion("native_files")}
                                disabled={state.exportState.status === "running"}
                            >
                                {text("library.native_export.action")}
                            </button>
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_inspector.009"
                                type="button"
                                className="library-secondary-button"
                                data-oaam-action="export-oaam-version-package"
                                onClick={() => void exportVersion("oaam_version_package")}
                                disabled={state.exportState.status === "running"}
                            >
                                {text("library.export.action")}
                            </button>
                        </div>
                        {state.exportState.status === "running" ? (
                            <WorkbenchNotice role="status">
                                {text(
                                    state.exportState.exportKind === "native_files"
                                        ? "library.native_export.running"
                                        : "library.export.running",
                                )}
                            </WorkbenchNotice>
                        ) : state.exportState.status === "complete" ? (
                            <WorkbenchNotice>
                                {text(
                                    state.exportState.exportKind === "native_files"
                                        ? "library.native_export.complete"
                                        : "library.export.complete",
                                    { bytes: state.exportState.archiveByteLength },
                                )}
                            </WorkbenchNotice>
                        ) : state.exportState.status === "failed" ? (
                            <>
                                <WorkbenchNotice tone="danger">{displayText(state.exportState.message)}</WorkbenchNotice>
                                <ProtocolDiagnostics
                                    diagnostics={state.exportState.diagnostics}
                                    technicalSummary={text("import.ui.technical_details")}
                                />
                            </>
                        ) : null}
                        {pickerMessage === undefined ? null : <WorkbenchNotice tone="danger">{pickerMessage}</WorkbenchNotice>}
                    </section>

                    <section className="inspector-section">
                        <h3>{text("library.inspector.files")}</h3>
                        <div className="asset-file-breadcrumb">
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_inspector.010"
                                type="button"
                                className="library-secondary-button"
                                disabled={state.directoryPath === ""}
                                onClick={() => void controller.enterDirectory(parentDirectory(state.directoryPath))}
                            >
                                {text("library.files.up")}
                            </button>
                            <code>/{state.directoryPath}</code>
                        </div>
                        {state.files.length === 0 ? (
                            <p>{text("library.inspector.no_files")}</p>
                        ) : (
                            <ul className="inspector-file-list">
                                {state.files.map((entry) =>
                                    entry.entryKind === "directory" ? (
                                        <li key={entry.logicalPath}>
                                            <button
                                                data-oaam-interaction-entry="features.project-library.asset_inspector.011"
                                                type="button"
                                                onClick={() => void controller.enterDirectory(entry.logicalPath)}
                                            >
                                                <strong>{entry.relativeName}/</strong>
                                                <span>
                                                    {text("library.files.descendants", { count: entry.descendantFileCount })}
                                                </span>
                                            </button>
                                        </li>
                                    ) : (
                                        <li key={entry.file.fileId}>
                                            <button
                                                data-oaam-interaction-entry="features.project-library.asset_inspector.012"
                                                data-oaam-action="preview-asset-file"
                                                className="inspector-file-button"
                                                type="button"
                                                onClick={() => selectPreviewFile(entry.file.logicalPath)}
                                            >
                                                <strong>
                                                    {entry.file.logicalPath === entry.relativeName
                                                        ? presentAssetFilePath(state.asset, entry.relativeName)
                                                        : entry.relativeName}
                                                </strong>
                                            </button>
                                            <div className="inspector-file-meta">
                                                <WorkbenchTechnicalFact
                                                    data-oaam-interaction-entry="features.project-library.asset_inspector.013"
                                                    fact={
                                                        <span>
                                                            {text(FILE_CONTENT_KIND_MESSAGES[entry.file.contentKind])} ·{" "}
                                                            {text("library.inspector.bytes", { count: entry.file.byteLength })}
                                                            {entry.file.executable
                                                                ? ` · ${text("library.inspector.executable")}`
                                                                : ""}
                                                        </span>
                                                    }
                                                    summary={text("import.ui.technical_details")}
                                                >
                                                    <code>
                                                        {text("discovery.product.technical.path", {
                                                            path: entry.file.logicalPath,
                                                        })}
                                                    </code>
                                                    <code>
                                                        {text("import.ui.technical.content_hash", {
                                                            contentHash: entry.file.contentHash,
                                                        })}
                                                    </code>
                                                </WorkbenchTechnicalFact>
                                            </div>
                                        </li>
                                    ),
                                )}
                            </ul>
                        )}
                        {state.filesHaveMore ? (
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_inspector.014"
                                type="button"
                                className="library-secondary-button"
                                onClick={() => void controller.loadMoreFiles()}
                            >
                                {text("library.files.more")}
                            </button>
                        ) : null}
                    </section>

                    {state.versions.length > 1 ? (
                        <section ref={comparisonSectionRef} className="inspector-section asset-comparison-section">
                            <h3>{text("library.compare.title")}</h3>
                            <div className="inspector-select-field">
                                <span>{text("library.compare.base")}</span>
                                <WorkbenchSelect
                                    data-oaam-interaction-entry="features.project-library.asset_inspector.015"
                                    label={text("library.compare.base")}
                                    value={comparisonVersionId}
                                    options={state.versions
                                        .filter((version) => version.versionId !== state.selectedVersion.versionId)
                                        .map((version) => ({
                                            value: version.versionId,
                                            label: text("library.assets.revision", { revision: version.revision }),
                                        }))}
                                    onChange={setComparisonVersionId}
                                />
                            </div>
                            <div className="detail-actions">
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_inspector.016"
                                    type="button"
                                    data-oaam-journey-action="asset.compare"
                                    disabled={comparisonVersionId === "" || state.comparison.status === "running"}
                                    onClick={() => void controller.compareWith(comparisonVersionId)}
                                >
                                    {text("library.compare.action")}
                                </button>
                                {state.comparison.status === "running" || state.comparison.status === "cancelling" ? (
                                    <button
                                        data-oaam-interaction-entry="features.project-library.asset_inspector.017"
                                        type="button"
                                        className="library-secondary-button"
                                        disabled={state.comparison.status === "cancelling"}
                                        onClick={() => void controller.cancelComparison()}
                                    >
                                        {text("common.cancel")}
                                    </button>
                                ) : null}
                            </div>
                            {state.comparison.status === "running" || state.comparison.status === "cancelling" ? (
                                <WorkbenchNotice role="status">
                                    {text("library.compare.progress", {
                                        stage: text(comparisonStageMessage(state.comparison.stage)),
                                        completed: state.comparison.completedUnits ?? 0,
                                        total: state.comparison.totalUnits ?? 0,
                                    })}
                                </WorkbenchNotice>
                            ) : state.comparison.status === "failed" ? (
                                <ProtocolFeedbackNotice
                                    message={state.comparison.message}
                                    diagnostics={state.comparison.diagnostics}
                                    tone="danger"
                                />
                            ) : state.comparison.status === "ready" ? (
                                <>
                                    <fieldset className="layout-switch" aria-label={text("library.compare.layout")}>
                                        <button
                                            data-oaam-interaction-entry="features.project-library.asset_inspector.018"
                                            type="button"
                                            className="library-secondary-button"
                                            aria-pressed={diffMode === "unified"}
                                            onClick={() => setDiffMode("unified")}
                                        >
                                            {text("library.compare.unified")}
                                        </button>
                                        <button
                                            data-oaam-interaction-entry="features.project-library.asset_inspector.019"
                                            type="button"
                                            className="library-secondary-button"
                                            aria-pressed={diffMode === "side_by_side"}
                                            onClick={() => setDiffMode("side_by_side")}
                                        >
                                            {text("library.compare.side_by_side")}
                                        </button>
                                    </fieldset>
                                    <AssetDiffView
                                        comparison={state.comparison.comparison}
                                        mode={diffMode}
                                        asset={state.asset}
                                        versions={state.versions}
                                    />
                                </>
                            ) : null}
                        </section>
                    ) : null}
                </div>
            )}
        </aside>
    );
}
