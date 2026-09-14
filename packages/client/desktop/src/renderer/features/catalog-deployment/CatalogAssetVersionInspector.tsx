import { useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton, WorkbenchNotice } from "../../ui";
import type { AdapterProviderView } from "../discovery/presentation";
import { AssetFilePreview, presentAssetFilePath } from "../asset-content-preview";
import { CatalogAssetSourceDetails } from "./CatalogAssetSourceInspector";
import type { CatalogDeploymentController } from "./catalog-deployment-controller";
import type { AssetVersionView } from "./catalog-deployment-model";
import type { CatalogAssetDetailState } from "./catalog-deployment-state";

export interface CatalogAssetVersionInspectorProps {
    readonly controller: CatalogDeploymentController;
    readonly detail: Exclude<CatalogAssetDetailState, { readonly status: "none" }>;
    readonly importSource?: AssetVersionView["importSource"];
    readonly providers?: readonly AdapterProviderView[];
    readonly revealableSourceRootIds?: readonly string[];
    readonly onRevealSourceRoot?: (sourceRootId: string) => Promise<{ readonly status: "complete" | "failed" }>;
}

export function CatalogAssetVersionInspector({
    controller,
    detail,
    importSource,
    providers = [],
    revealableSourceRootIds,
    onRevealSourceRoot,
}: CatalogAssetVersionInspectorProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const [inspectorView, setInspectorView] = useState<"version" | "source">("version");
    const sourceVisible = inspectorView === "source" && importSource !== undefined;
    const selectedLogicalPath =
        detail.status === "ready" && detail.preview.status !== "none" ? detail.preview.logicalPath : undefined;
    return (
        <aside
            className="asset-inspector catalog-asset-version-inspector"
            aria-label={text(sourceVisible ? "catalog.ui.asset.source_details" : "catalog.ui.asset.current_version")}
            data-oaam-state={detail.status}
            data-oaam-asset-id={detail.status === "ready" ? detail.asset.assetId : detail.assetId}
            data-oaam-version-id={detail.status === "ready" ? detail.version.versionId : undefined}
            data-oaam-inspector-view={sourceVisible ? "source" : "version"}
        >
            <header className="asset-inspector-header">
                <div>
                    <span>
                        {text(sourceVisible ? "catalog.ui.asset.source_details" : "catalog.ui.asset.current_version")}
                        {!sourceVisible && detail.status === "ready"
                            ? ` · ${text("catalog.product.asset.revision", { revision: detail.version.revision })}`
                            : ""}
                    </span>
                    <h2>{detail.status === "ready" ? detail.asset.displayName : text("library.inspector.title")}</h2>
                </div>
                {importSource === undefined ? null : (
                    <nav className="asset-inspector-modes" aria-label={text("library.inspector.views")}>
                        <button
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.003"
                            data-oaam-inspector-view-choice="version"
                            type="button"
                            aria-pressed={!sourceVisible}
                            onClick={() => setInspectorView("version")}
                        >
                            {text("catalog.ui.asset.current_version")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.004"
                            data-oaam-inspector-view-choice="source"
                            type="button"
                            aria-pressed={sourceVisible}
                            onClick={() => setInspectorView("source")}
                        >
                            {text("catalog.ui.asset.source_details")}
                        </button>
                    </nav>
                )}
                <WorkbenchIconButton
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.001"
                    className="library-icon-button"
                    icon="close"
                    label={text("library.inspector.close")}
                    onClick={() => controller.clearAssetSelection()}
                />
            </header>
            {sourceVisible ? (
                <CatalogAssetSourceDetails
                    importSource={importSource}
                    providers={providers}
                    revealableSourceRootIds={revealableSourceRootIds}
                    onRevealSourceRoot={onRevealSourceRoot}
                />
            ) : detail.status === "loading" ? (
                <WorkbenchNotice className="inspector-status" role="status" aria-busy="true">
                    {text("catalog.ui.asset.loading_detail")}
                </WorkbenchNotice>
            ) : detail.status === "failed" ? (
                <WorkbenchNotice className="inspector-status" tone="danger" role="alert">
                    {displayText(detail.message)}
                </WorkbenchNotice>
            ) : detail.version.files.length === 0 ? (
                <WorkbenchNotice className="inspector-status">{text("library.inspector.no_files")}</WorkbenchNotice>
            ) : (
                <div className="asset-inspector-preview-pane catalog-version-preview-pane">
                    {detail.version.files.length > 1 ? (
                        <nav className="catalog-version-file-tabs" aria-label={text("library.inspector.files")}>
                            {detail.version.files.map((file) => (
                                <button
                                    data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.002"
                                    key={file.fileId}
                                    type="button"
                                    title={file.logicalPath}
                                    aria-pressed={selectedLogicalPath === file.logicalPath}
                                    onClick={() => void controller.selectAssetFile(file.logicalPath)}
                                >
                                    {presentAssetFilePath(detail.asset, file.logicalPath)}
                                </button>
                            ))}
                        </nav>
                    ) : null}
                    {detail.preview.status === "none" ? (
                        <WorkbenchNotice className="inspector-status" role="status" aria-busy="true">
                            {text("library.preview.loading")}
                        </WorkbenchNotice>
                    ) : (
                        <AssetFilePreview
                            key={detail.preview.logicalPath}
                            preview={detail.preview}
                            displayPath={presentAssetFilePath(detail.asset, detail.preview.logicalPath)}
                            onLoadMoreText={() => void controller.loadMoreAssetText()}
                        />
                    )}
                </div>
            )}
        </aside>
    );
}
