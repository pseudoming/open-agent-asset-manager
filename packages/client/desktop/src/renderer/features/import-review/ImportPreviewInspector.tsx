import { useLayoutEffect, useRef, useState } from "react";
import type { DesktopImportPreviewFileReference, ImportPreviewFileRevealResult } from "../../../bridge/desktop-bridge";
import { localizedText, ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import {
    WorkbenchFileInspector,
    WorkbenchFileTabs,
    WorkbenchIconButton,
    WorkbenchNotice,
    useWorkbenchFileInspectorWidth,
} from "../../ui";
import { formatJsonPreview, ImportPreviewText, type ImportPreviewTextMode, importPreviewTextFormat } from "./ImportPreviewText";
import type { ImportReviewDetailState } from "./import-review-controller";
import type { ImportCandidateView } from "./import-review-model";

export interface ImportPreviewTab {
    readonly tabKey: string;
    readonly candidateId: string;
    readonly logicalPath?: string;
    readonly label: string;
    readonly title?: string;
}

export interface ImportPreviewInspectorProps {
    readonly previewToken: string;
    readonly candidates: readonly ImportCandidateView[];
    readonly tabs: readonly ImportPreviewTab[];
    readonly activeTabKey: string | undefined;
    readonly detail: ImportReviewDetailState;
    readonly fileListVisible: boolean;
    readonly busy: boolean;
    readonly railWidth: number;
    readonly revealImportPreviewFile?: (reference: DesktopImportPreviewFileReference) => Promise<ImportPreviewFileRevealResult>;
    readonly onSelectTab: (tab: ImportPreviewTab) => void;
    readonly onCloseTab: (tabKey: string) => void;
    readonly onOpenFile: (candidateId: string, logicalPath?: string) => void;
    readonly onToggleFileList: () => void;
    readonly onResizeRail: (width: number) => void;
    readonly onClose: () => void;
}

type RevealState = "idle" | "opening" | "complete" | "failed";

function sameRequestedDetail(detail: ImportReviewDetailState, tab: ImportPreviewTab | undefined): boolean {
    if (tab === undefined || detail.status === "none") return false;
    if (detail.status === "ready") {
        return (
            detail.value.candidateId === tab.candidateId &&
            (tab.logicalPath === undefined || detail.value.logicalPath === tab.logicalPath)
        );
    }
    return detail.candidateId === tab.candidateId && detail.logicalPath === tab.logicalPath;
}

export function ImportPreviewInspector({
    previewToken,
    candidates,
    tabs,
    activeTabKey,
    detail,
    fileListVisible,
    busy,
    railWidth,
    revealImportPreviewFile,
    onSelectTab,
    onCloseTab,
    onOpenFile,
    onToggleFileList,
    onResizeRail,
    onClose,
}: ImportPreviewInspectorProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const [revealState, setRevealState] = useState<RevealState>("idle");
    const [textMode, setTextMode] = useState<ImportPreviewTextMode>("source");
    const [softWrap, setSoftWrap] = useState(false);
    const inspector = useRef<HTMLElement>(null);
    const revealOperation = useRef<{ readonly previewToken: string; readonly activeTabKey: string | undefined } | null>(null);
    const activeTab = tabs.find((tab) => tab.tabKey === activeTabKey);
    const activeCandidate = candidates.find((candidate) => candidate.candidateId === activeTab?.candidateId);
    const detailMatches = sameRequestedDetail(detail, activeTab);
    const previewReady = detailMatches && detail.status === "ready";
    const textFormat =
        previewReady && detail.value.contentKind === "text" && detail.value.text !== undefined
            ? importPreviewTextFormat(activeTab?.logicalPath ?? activeTab?.label, detail.value.mediaType)
            : "plain";
    const jsonCanFormat =
        previewReady && textFormat === "json" && detail.value.contentKind === "text" && detail.value.text !== undefined
            ? formatJsonPreview(detail.value.text.text) !== undefined
            : false;
    const alternateViewAvailable = textFormat === "markdown" || (textFormat === "json" && jsonCanFormat);
    const { width: displayedWidth, maximumWidth: maximumRailWidth } = useWorkbenchFileInspectorWidth(railWidth, 320);

    useLayoutEffect(() => {
        revealOperation.current = { activeTabKey, previewToken };
        setRevealState("idle");
        setTextMode("source");
        setSoftWrap(false);
        return () => {
            revealOperation.current = null;
        };
    }, [activeTabKey, previewToken]);

    useLayoutEffect(() => {
        const shell = inspector.current?.closest<HTMLElement>(".guided-import-shell, .onboarding-shell");
        if (shell === undefined || shell === null) return;
        shell.style.setProperty("--import-preview-rail-width", `${String(displayedWidth)}px`);
        return () => {
            shell.style.removeProperty("--import-preview-rail-width");
        };
    }, [displayedWidth]);

    async function revealFile(): Promise<void> {
        if (activeTab === undefined || revealImportPreviewFile === undefined || revealState === "opening") return;
        const operation = { activeTabKey, previewToken };
        revealOperation.current = operation;
        setRevealState("opening");
        try {
            const result = await revealImportPreviewFile({
                previewToken,
                candidateId: activeTab.candidateId,
                ...(activeTab.logicalPath === undefined ? {} : { logicalPath: activeTab.logicalPath }),
            });
            if (operation === revealOperation.current) setRevealState(result.status === "complete" ? "complete" : "failed");
        } catch {
            if (operation === revealOperation.current) setRevealState("failed");
        }
    }

    return (
        <WorkbenchFileInspector
            className="import-preview-inspector"
            label={text("import.ui.inspector.label")}
            ref={inspector}
            width={displayedWidth}
            maximumWidth={maximumRailWidth}
            resizeLabel={text("import.ui.inspector.resize")}
            resizeEntry="features.import-review.import_preview_inspector.001"
            onResize={onResizeRail}
        >
            <header className="import-preview-inspector-header">
                <WorkbenchFileTabs
                    tabs={tabs}
                    activeTabKey={activeTabKey}
                    label={text("import.ui.inspector.open_files")}
                    closeLabel={(tab) => text("import.ui.inspector.close_file", { path: tab.label })}
                    selectEntry="features.import-review.import_preview_inspector.002"
                    closeEntry="features.import-review.import_preview_inspector.003"
                    onSelect={onSelectTab}
                    onClose={onCloseTab}
                />
                <nav aria-label={text("import.ui.inspector.actions")}>
                    {previewReady && textFormat !== "plain" ? (
                        <WorkbenchIconButton
                            data-oaam-interaction-entry="features.import-review.import_preview_inspector.004"
                            className="import-preview-view-button"
                            icon={textMode === "alternate" ? "source" : textFormat === "json" ? "format" : "render"}
                            label={text(
                                textFormat === "json"
                                    ? !jsonCanFormat
                                        ? "import.ui.inspector.json_invalid"
                                        : textMode === "source"
                                          ? "import.ui.inspector.format_json"
                                          : "import.ui.inspector.show_json_source"
                                    : textMode === "source"
                                      ? "import.ui.inspector.render_markdown"
                                      : "import.ui.inspector.show_markdown_source",
                            )}
                            aria-pressed={textMode === "alternate"}
                            disabled={!alternateViewAvailable}
                            onClick={() => setTextMode((current) => (current === "source" ? "alternate" : "source"))}
                        />
                    ) : null}
                    {previewReady && textMode === "source" && detail.value.contentKind === "text" ? (
                        <WorkbenchIconButton
                            data-oaam-interaction-entry="features.import-review.import_preview_inspector.005"
                            className="import-preview-view-button"
                            icon="wrap"
                            label={text(softWrap ? "import.ui.inspector.disable_wrap" : "import.ui.inspector.enable_wrap")}
                            aria-pressed={softWrap}
                            onClick={() => setSoftWrap((current) => !current)}
                        />
                    ) : null}
                    <WorkbenchIconButton
                        data-oaam-interaction-entry="features.import-review.import_preview_inspector.006"
                        icon="list"
                        label={text(fileListVisible ? "import.ui.inspector.hide_files" : "import.ui.inspector.show_files")}
                        aria-pressed={fileListVisible}
                        disabled={activeCandidate === undefined}
                        onClick={onToggleFileList}
                    />
                    <WorkbenchIconButton
                        data-oaam-interaction-entry="features.import-review.import_preview_inspector.007"
                        icon="reveal"
                        label={text("import.ui.inspector.reveal")}
                        disabled={
                            activeTab === undefined || revealImportPreviewFile === undefined || revealState === "opening" || busy
                        }
                        onClick={() => void revealFile()}
                    />
                    <WorkbenchIconButton
                        data-oaam-interaction-entry="features.import-review.import_preview_inspector.008"
                        icon="close"
                        label={text("import.ui.inspector.close")}
                        onClick={onClose}
                    />
                </nav>
            </header>
            <div className="import-preview-inspector-body" data-file-list-visible={fileListVisible}>
                {fileListVisible && activeCandidate !== undefined ? (
                    <nav className="import-preview-file-list" aria-label={text("import.ui.inspector.files")}>
                        <strong>{text("import.ui.inspector.files")}</strong>
                        <ul>
                            {activeCandidate.logicalPaths.map((logicalPath) => (
                                <li key={logicalPath}>
                                    <button
                                        data-oaam-interaction-entry="features.import-review.import_preview_inspector.009"
                                        type="button"
                                        aria-current={
                                            (previewReady ? detail.value.logicalPath : activeTab?.logicalPath) === logicalPath
                                                ? "page"
                                                : undefined
                                        }
                                        title={logicalPath}
                                        onClick={() => onOpenFile(activeCandidate.candidateId, logicalPath)}
                                    >
                                        {logicalPath}
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {activeCandidate.logicalPathsTruncated ? <small>{text("import.ui.files_omitted")}</small> : null}
                    </nav>
                ) : null}
                <div className="import-preview-inspector-content" data-preview-ready={previewReady}>
                    {activeTab === undefined ? (
                        <WorkbenchNotice tone="empty">{text("import.ui.inspector.empty")}</WorkbenchNotice>
                    ) : !detailMatches || detail.status === "loading" ? (
                        <WorkbenchNotice role="status" aria-busy="true">
                            {text("import.ui.detail.loading")}
                        </WorkbenchNotice>
                    ) : detail.status === "failed" ? (
                        <>
                            <WorkbenchNotice tone="danger" role="alert">
                                {displayText(detail.message)}
                            </WorkbenchNotice>
                            <ProtocolDiagnostics
                                attribution={localizedText("import.ui.diagnostics.attribution")}
                                diagnostics={detail.diagnostics}
                                technicalSummary={text("import.ui.technical_details")}
                            />
                        </>
                    ) : detail.status === "ready" ? (
                        <article className="import-preview-document" aria-label={activeTab.label}>
                            {detail.value.contentKind === "text" && detail.value.text !== undefined ? (
                                <>
                                    {detail.value.text.truncated ? (
                                        <WorkbenchNotice>{text("import.ui.detail.text_truncated")}</WorkbenchNotice>
                                    ) : null}
                                    <ImportPreviewText
                                        format={textFormat}
                                        mode={textMode}
                                        text={detail.value.text.text}
                                        sourceLabel={text("import.ui.inspector.source_with_lines")}
                                        renderedLabel={text("import.ui.inspector.rendered_markdown")}
                                        softWrap={softWrap}
                                    />
                                </>
                            ) : (
                                <p>{text("import.ui.binary_copy")}</p>
                            )}
                        </article>
                    ) : null}
                    {revealState === "complete" ? (
                        <WorkbenchNotice role="status">{text("import.ui.inspector.reveal_complete")}</WorkbenchNotice>
                    ) : revealState === "failed" ? (
                        <WorkbenchNotice tone="danger" role="alert">
                            {text("import.ui.inspector.reveal_failed")}
                        </WorkbenchNotice>
                    ) : null}
                </div>
            </div>
        </WorkbenchFileInspector>
    );
}
