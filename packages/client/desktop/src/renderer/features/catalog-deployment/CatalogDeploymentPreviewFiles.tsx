import { useEffect, useRef, useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton, WorkbenchTechnicalFact } from "../../ui";
import type { RenderPreviewView } from "./catalog-deployment-model";
import { CatalogDeploymentFileInspector, type CatalogPreviewFileRequest } from "./CatalogDeploymentFileInspector";
import {
    PREVIEW_DIRECTORY_CHANGE_MESSAGES,
    previewEntryIsUnchanged,
    previewFileChangeMessage,
    previewGraphPathLabels,
} from "./render-review-presentation";

export function CatalogDeploymentPreviewFiles({
    files,
    directories,
    suspended = false,
    onOpenReview,
}: {
    readonly files: RenderPreviewView["files"];
    readonly directories: RenderPreviewView["directories"];
    readonly suspended?: boolean;
    readonly onOpenReview?: () => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const paths = previewGraphPathLabels({ files, directories });
    const [request, setRequest] = useState<CatalogPreviewFileRequest>();
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (suspended) setRequest(undefined);
    }, [suspended]);
    function openReview(relativePath: string, button: HTMLButtonElement): void {
        trigger.current = button;
        onOpenReview?.();
        setRequest({ relativePath });
    }
    function directoryRows(entries: RenderPreviewView["directories"]): React.JSX.Element | null {
        return entries.length === 0 ? null : (
            <section className="catalog-preview-graph-section" data-oaam-preview-graph-section="directories">
                <h4>{text("catalog.ui.preview.directory.title")}</h4>
                <ul className="catalog-preview-graph-list">
                    {entries.map((directory) => (
                        <li key={directory.relativePath}>
                            <article
                                className="catalog-preview-graph-row catalog-preview-directory-row"
                                data-oaam-preview-entry-kind="directory"
                                data-oaam-preview-boundary={directory.managedBoundaryRelativePath}
                                data-oaam-preview-path={directory.relativePath}
                                data-oaam-preview-baseline-state={directory.baselineState}
                                data-oaam-preview-change-kind={directory.changeKind}
                                data-oaam-preview-current-state={directory.currentState}
                                data-oaam-preview-desired-state={directory.desiredState}
                            >
                                <div className="catalog-preview-file-heading">
                                    <strong>{paths.label(directory.relativePath)}/</strong>
                                </div>
                                <p>{text(PREVIEW_DIRECTORY_CHANGE_MESSAGES[directory.changeKind])}</p>
                                <small>
                                    {text("catalog.ui.preview.state", {
                                        current: text(`catalog.ui.preview.${directory.currentState}`),
                                        desired: text(`catalog.ui.preview.${directory.desiredState}`),
                                    })}
                                </small>
                            </article>
                        </li>
                    ))}
                </ul>
            </section>
        );
    }
    function fileRows(entries: RenderPreviewView["files"]): React.JSX.Element | null {
        return entries.length === 0 ? null : (
            <section className="catalog-preview-graph-section" data-oaam-preview-graph-section="files">
                <ul className="catalog-preview-graph-list">
                    {entries.map((file) => (
                        <li key={file.relativePath}>
                            <article
                                className="catalog-preview-graph-row catalog-preview-file-row"
                                data-oaam-preview-entry-kind="file"
                                data-oaam-preview-path={file.relativePath}
                                data-oaam-preview-baseline-state={file.baselineState}
                                data-oaam-preview-change-kind={file.changeKind}
                                data-oaam-preview-current-state={file.current.state}
                                data-oaam-preview-desired-state={file.desired.state}
                                data-oaam-preview-desired-byte-size={
                                    file.desired.state === "present" ? file.desired.byteSize : undefined
                                }
                                data-oaam-preview-desired-sha256={
                                    file.desired.state === "present" ? file.desired.contentHash : undefined
                                }
                            >
                                <div className="catalog-preview-file-heading">
                                    <strong>{paths.label(file.relativePath)}</strong>
                                    <WorkbenchIconButton
                                        icon="preview"
                                        label={text("import.ui.detail.view", { path: paths.label(file.relativePath) })}
                                        data-oaam-preview-review-path={file.relativePath}
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_preview_files.002"
                                        onClick={(event) => openReview(file.relativePath, event.currentTarget)}
                                    />
                                </div>
                                <WorkbenchTechnicalFact
                                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.028"
                                    className="catalog-preview-technical-details"
                                    fact={<p>{text(previewFileChangeMessage(file))}</p>}
                                    summary={text("import.ui.technical_details")}
                                >
                                    <small>
                                        {text("catalog.ui.preview.state", {
                                            current:
                                                file.current.state === "missing"
                                                    ? text("catalog.ui.preview.missing")
                                                    : `${file.current.contentKind} · ${file.current.byteSize} B · ${file.current.contentHash}`,
                                            desired:
                                                file.desired.state === "missing"
                                                    ? text("catalog.ui.preview.missing")
                                                    : `${file.desired.contentKind} · ${file.desired.byteSize} B · ${file.desired.contentHash}`,
                                        })}
                                    </small>
                                </WorkbenchTechnicalFact>
                            </article>
                        </li>
                    ))}
                </ul>
            </section>
        );
    }
    const changedFiles = files.filter((file) => !previewEntryIsUnchanged(file));
    const changedDirectories = directories.filter((directory) => !previewEntryIsUnchanged(directory));
    const unchangedFiles = files.filter(previewEntryIsUnchanged);
    const unchangedDirectories = directories.filter(previewEntryIsUnchanged);
    const unchangedCount = unchangedFiles.length + unchangedDirectories.length;
    return (
        <div className="catalog-preview-graph" data-oaam-preview-graph="complete">
            {paths.root === undefined ? null : <p className="catalog-preview-root">{paths.root}/</p>}
            <div data-oaam-preview-graph-changes>
                {fileRows(changedFiles)}
                {directoryRows(changedDirectories)}
            </div>
            {unchangedCount === 0 ? null : (
                <details className="catalog-preview-unchanged" data-oaam-preview-graph-unchanged>
                    <summary data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_preview_files.003">
                        {text("catalog.product.replace.unchanged", { count: unchangedCount })}
                    </summary>
                    {directoryRows(unchangedDirectories)}
                    {fileRows(unchangedFiles)}
                </details>
            )}
            {request === undefined || suspended ? null : (
                <CatalogDeploymentFileInspector
                    files={files}
                    directories={directories}
                    request={request}
                    onClose={() => {
                        setRequest(undefined);
                        trigger.current?.focus({ preventScroll: true });
                    }}
                />
            )}
        </div>
    );
}
