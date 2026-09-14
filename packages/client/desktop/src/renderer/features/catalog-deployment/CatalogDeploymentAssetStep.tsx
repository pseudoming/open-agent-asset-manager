import { useLayoutEffect, useRef } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchBadge, WorkbenchConfirmation, WorkbenchIconButton, WorkbenchPanel, WorkbenchTechnicalFact } from "../../ui";
import { type AdapterProviderView, presentDiscoveryTool } from "../discovery/presentation";
import { ASSET_KIND_MESSAGE_IDS } from "../project-library/model";
import type { AssetSummaryView, AssetVersionView } from "./catalog-deployment-model";

export interface CatalogDeploymentAssetStepProps {
    readonly asset: AssetSummaryView;
    readonly allowIncomplete: boolean;
    readonly disabled: boolean;
    readonly importSource?: AssetVersionView["importSource"];
    readonly providers: readonly AdapterProviderView[];
    readonly onAllowIncompleteChange: (allowIncomplete: boolean) => void;
    readonly onPreview: () => void;
}

export function CatalogDeploymentAssetStep({
    asset,
    allowIncomplete,
    disabled,
    importSource,
    providers,
    onAllowIncompleteChange,
    onPreview,
}: CatalogDeploymentAssetStepProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const contextRow = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const row = contextRow.current;
        const page = row?.closest<HTMLElement>(".deployment-page");
        if (row === null || page === undefined || page === null) return;
        const updateHeight = (): void => {
            page.style.setProperty("--oaam-deployment-context-height", `${row.getBoundingClientRect().height}px`);
        };
        updateHeight();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateHeight);
        observer?.observe(row);
        let focusFrame: number | undefined;
        const revealFocusedControl = (event: FocusEvent): void => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || row.contains(target)) return;
            if (!(row.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
            if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
            focusFrame = requestAnimationFrame(() => {
                if (document.activeElement !== target) return;
                const control = target.matches(".workbench-semantic-input") ? (target.closest("label") ?? target) : target;
                const bounds = control.getBoundingClientRect();
                const contextBounds = row.getBoundingClientRect();
                const pageBounds = page.getBoundingClientRect();
                if (contextBounds.height === 0 || contextBounds.top > pageBounds.top + 1) return;
                if (bounds.top < contextBounds.bottom + 8 || bounds.bottom > pageBounds.bottom - 8) {
                    control.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
                }
            });
        };
        page.addEventListener("focusin", revealFocusedControl);
        globalThis.addEventListener("resize", updateHeight);
        return () => {
            observer?.disconnect();
            if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
            page.removeEventListener("focusin", revealFocusedControl);
            globalThis.removeEventListener("resize", updateHeight);
            page.style.removeProperty("--oaam-deployment-context-height");
        };
    }, []);
    return (
        <WorkbenchPanel
            surface="section"
            className="deployment-journey-step deployment-selected-asset"
            aria-labelledby="deployment-asset-title"
            data-oaam-deployment-step="asset"
        >
            <h2 id="deployment-asset-title" className="sr-only">
                {text("catalog.ui.create.asset_step_eyebrow")}
            </h2>
            <div className="deployment-selected-asset-row" ref={contextRow}>
                <div className="deployment-selected-asset-identity">
                    <strong>{asset.displayName}</strong>
                    <div className="deployment-selected-asset-meta">
                        <small>
                            {text("catalog.product.asset.summary", {
                                kind: text(ASSET_KIND_MESSAGE_IDS[asset.kind]),
                                scope: text(
                                    asset.scope === "global" ? "import.ui.asset.scope.global" : "import.ui.asset.scope.project",
                                ),
                            })}
                            <span aria-hidden="true"> · </span>
                            {text("catalog.product.asset.revision", { revision: asset.currentRevision })}
                        </small>
                        {importSource === undefined ? null : (
                            <WorkbenchTechnicalFact
                                className="deployment-selected-asset-source"
                                data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_asset_step.003"
                                fact={
                                    <WorkbenchBadge data-oaam-asset-import-source={importSource.adapterId}>
                                        {text("catalog.ui.asset.imported_from", {
                                            tool: displayText(presentDiscoveryTool(importSource.adapterId, providers).label),
                                        })}
                                    </WorkbenchBadge>
                                }
                                summary={text("catalog.ui.asset.source_details")}
                            >
                                {importSource.roots.map((sourceRoot) => (
                                    <code key={sourceRoot.sourceRootId}>{sourceRoot.canonicalPath}</code>
                                ))}
                            </WorkbenchTechnicalFact>
                        )}
                    </div>
                </div>
                <span className="deployment-selected-asset-actions">
                    <WorkbenchBadge tone={asset.currentVersionStatus === "complete" ? "success" : "warning"}>
                        {text(
                            asset.currentVersionStatus === "complete"
                                ? "import.ui.asset.status.ready"
                                : "import.ui.asset.status.incomplete",
                        )}
                    </WorkbenchBadge>
                    <WorkbenchIconButton
                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_asset_step.001"
                        data-oaam-asset-action="inspect_version"
                        className="library-icon-button catalog-asset-version-button"
                        icon="preview"
                        label={text("catalog.ui.asset.view_version")}
                        disabled={disabled}
                        onClick={onPreview}
                    />
                </span>
            </div>
            {asset.currentVersionStatus === "incomplete" ? (
                <WorkbenchConfirmation
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_asset_step.002"
                    checked={allowIncomplete}
                    disabled={disabled}
                    onCheckedChange={onAllowIncompleteChange}
                >
                    {text("catalog.ui.create.allow_incomplete")}
                </WorkbenchConfirmation>
            ) : null}
        </WorkbenchPanel>
    );
}
