import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import {
    DesktopIcon,
    WorkbenchFileInspector,
    type WorkbenchFileTab,
    WorkbenchFileTabs,
    WorkbenchIconButton,
    WorkbenchNotice,
    useWorkbenchFileInspectorWidth,
} from "../../ui";
import { ImportPreviewText } from "../import-review";
import type { RenderPreviewView } from "./catalog-deployment-model";
import { CatalogPreviewTextDiff } from "./CatalogPreviewTextDiff";
import {
    PREVIEW_DIRECTORY_CHANGE_MESSAGES,
    previewFileChangeMessage,
    previewGraphPathLabels,
} from "./render-review-presentation";

interface FileTab {
    readonly relativePath: string;
    readonly side: "current" | "desired";
    readonly tabKey: string;
}

export interface CatalogPreviewFileRequest {
    readonly relativePath: string;
}

export function CatalogDeploymentFileInspector({
    files,
    directories,
    request,
    onClose,
}: {
    readonly files: RenderPreviewView["files"];
    readonly directories: RenderPreviewView["directories"];
    readonly request: CatalogPreviewFileRequest;
    readonly onClose: () => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const [selectedPath, setSelectedPath] = useState(request.relativePath);
    const [activeTabKey, setActiveTabKey] = useState("review");
    const [fileTabs, setFileTabs] = useState<readonly FileTab[]>([]);
    const [fileListVisible, setFileListVisible] = useState(files.length + directories.length > 1);
    const [width, setWidth] = useState(() => Math.max(336, Math.min(1440, Math.round(globalThis.innerWidth * 0.4))));
    const [softWrap, setSoftWrap] = useState(false);
    const inspector = useRef<HTMLElement>(null);
    const { width: displayedWidth, maximumWidth } = useWorkbenchFileInspectorWidth(width, 480);
    const paths = previewGraphPathLabels({ files, directories });
    const activeFileTab = fileTabs.find((tab) => tab.tabKey === activeTabKey);
    const path = activeFileTab?.relativePath ?? selectedPath;
    const file = files.find((entry) => entry.relativePath === path);
    const directory = directories.find((entry) => entry.relativePath === path);
    const activeSnapshot = activeFileTab === undefined || file === undefined ? undefined : file[activeFileTab.side];
    const currentText =
        file?.current.state === "missing" ? "" : file?.current.contentKind === "text" ? file.current.text : undefined;
    const desiredText =
        file?.desired.state === "missing" ? "" : file?.desired.contentKind === "text" ? file.desired.text : undefined;

    useEffect(() => {
        setSelectedPath(request.relativePath);
        setActiveTabKey("review");
    }, [request]);
    useLayoutEffect(() => {
        const page = inspector.current?.closest<HTMLElement>(".deployment-page");
        if (page === undefined || page === null) return;
        page.dataset.fileInspectorOpen = "true";
        page.style.setProperty("--oaam-file-inspector-width", `${String(displayedWidth)}px`);
        return () => {
            delete page.dataset.fileInspectorOpen;
            page.style.removeProperty("--oaam-file-inspector-width");
        };
    }, [displayedWidth]);

    function openFileTab(side: "current" | "desired"): void {
        if (file === undefined || file[side].state !== "present") return;
        const tabKey = `${side}\0${file.relativePath}`;
        setFileTabs((current) =>
            current.some((tab) => tab.tabKey === tabKey)
                ? current
                : [...current, { tabKey, side, relativePath: file.relativePath }],
        );
        setActiveTabKey(tabKey);
    }

    return (
        <WorkbenchFileInspector
            className="catalog-deployment-file-inspector"
            label={text("catalog.ui.preview.title")}
            ref={inspector}
            width={displayedWidth}
            maximumWidth={maximumWidth}
            resizeLabel={text("import.ui.inspector.resize")}
            resizeEntry="features.catalog-deployment.catalog_deployment_file_inspector.001"
            onResize={setWidth}
        >
            <header className="import-preview-inspector-header">
                <WorkbenchFileTabs<WorkbenchFileTab>
                    tabs={[
                        { tabKey: "review", label: text("catalog.ui.preview.review_tab") },
                        ...fileTabs.map((tab) => ({
                            tabKey: tab.tabKey,
                            label: paths.label(tab.relativePath),
                            prefix: text(
                                tab.side === "current" ? "catalog.ui.preview.current_tab" : "catalog.ui.preview.desired_tab",
                            ),
                            title: `${text(tab.side === "current" ? "catalog.ui.preview.current_text" : "catalog.ui.preview.desired_text")} · ${tab.relativePath}`,
                        })),
                    ]}
                    activeTabKey={activeTabKey}
                    label={text("import.ui.inspector.open_files")}
                    closeLabel={(tab) => text("import.ui.inspector.close_file", { path: tab.title ?? tab.label })}
                    selectEntry="features.catalog-deployment.catalog_deployment_file_inspector.002"
                    closeEntry="features.catalog-deployment.catalog_deployment_file_inspector.003"
                    onSelect={(tab) => setActiveTabKey(tab.tabKey)}
                    onClose={(tabKey) => {
                        if (tabKey === "review") return onClose();
                        setFileTabs((current) => current.filter((tab) => tab.tabKey !== tabKey));
                        if (activeTabKey === tabKey) setActiveTabKey("review");
                    }}
                />
                <nav aria-label={text("import.ui.inspector.actions")}>
                    {activeFileTab === undefined ? null : (
                        <WorkbenchIconButton
                            icon="wrap"
                            label={text(softWrap ? "import.ui.inspector.disable_wrap" : "import.ui.inspector.enable_wrap")}
                            aria-pressed={softWrap}
                            onClick={() => setSoftWrap((current) => !current)}
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.004"
                        />
                    )}
                    <WorkbenchIconButton
                        icon="list"
                        label={text(fileListVisible ? "import.ui.inspector.hide_files" : "import.ui.inspector.show_files")}
                        aria-pressed={fileListVisible}
                        onClick={() => setFileListVisible((current) => !current)}
                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.005"
                    />
                    <WorkbenchIconButton
                        icon="close"
                        label={text("import.ui.inspector.close")}
                        onClick={onClose}
                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.006"
                    />
                </nav>
            </header>
            <div className="import-preview-inspector-body" data-file-list-visible={fileListVisible}>
                {fileListVisible ? (
                    <nav className="import-preview-file-list" aria-label={text("catalog.ui.preview.title")}>
                        <strong>{paths.root ?? text("catalog.ui.preview.title")}</strong>
                        <ul>
                            {[
                                ...directories.map((entry) => ({ path: entry.relativePath, directory: true })),
                                ...files.map((entry) => ({ path: entry.relativePath, directory: false })),
                            ].map((entry) => (
                                <li key={entry.path}>
                                    <button
                                        type="button"
                                        title={entry.path}
                                        aria-current={path === entry.path ? "page" : undefined}
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.007"
                                        onClick={() => {
                                            setSelectedPath(entry.path);
                                            setActiveTabKey("review");
                                        }}
                                    >
                                        {paths.label(entry.path)}
                                        {entry.directory ? "/" : ""}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </nav>
                ) : null}
                <div className="import-preview-inspector-content catalog-file-review-content">
                    <header className="catalog-file-review-heading">
                        <strong title={path}>
                            {paths.label(path)}
                            {directory === undefined ? "" : "/"}
                        </strong>
                        <p>{text("catalog.ui.preview.snapshot_copy")}</p>
                        {file === undefined ? null : (
                            <>
                                <p>{text(previewFileChangeMessage(file))}</p>
                                <div className="detail-actions">
                                    {(["current", "desired"] as const).map((side) =>
                                        file[side].state !== "present" ? null : (
                                            <button
                                                key={side}
                                                type="button"
                                                className="library-secondary-button"
                                                aria-label={text(
                                                    side === "current"
                                                        ? "catalog.ui.preview.open_current"
                                                        : "catalog.ui.preview.open_desired",
                                                )}
                                                data-oaam-preview-open-snapshot={side}
                                                data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.008"
                                                onClick={() => openFileTab(side)}
                                            >
                                                <DesktopIcon name="source" size={14} />
                                                {text(
                                                    side === "current"
                                                        ? "catalog.ui.preview.current_text"
                                                        : "catalog.ui.preview.desired_text",
                                                )}
                                            </button>
                                        ),
                                    )}
                                </div>
                            </>
                        )}
                    </header>
                    {activeSnapshot !== undefined ? (
                        activeSnapshot.state === "present" && activeSnapshot.contentKind === "text" ? (
                            <div className="catalog-preview-file-document" data-oaam-preview-text-kind={activeFileTab?.side}>
                                <ImportPreviewText
                                    format="plain"
                                    mode="source"
                                    text={activeSnapshot.text}
                                    sourceLabel={text("import.ui.inspector.source_with_lines")}
                                    renderedLabel={text("import.ui.inspector.source_with_lines")}
                                    softWrap={softWrap}
                                />
                            </div>
                        ) : (
                            <WorkbenchNotice>{text("library.preview.binary")}</WorkbenchNotice>
                        )
                    ) : directory !== undefined ? (
                        <>
                            <p>{text(PREVIEW_DIRECTORY_CHANGE_MESSAGES[directory.changeKind])}</p>
                            <p>
                                {text("catalog.ui.preview.state", {
                                    current: text(`catalog.ui.preview.${directory.currentState}`),
                                    desired: text(`catalog.ui.preview.${directory.desiredState}`),
                                })}
                            </p>
                        </>
                    ) : currentText !== undefined && desiredText !== undefined ? (
                        <CatalogPreviewTextDiff current={currentText} desired={desiredText} key={path} />
                    ) : (
                        <WorkbenchNotice>{text("library.preview.binary")}</WorkbenchNotice>
                    )}
                </div>
            </div>
        </WorkbenchFileInspector>
    );
}
