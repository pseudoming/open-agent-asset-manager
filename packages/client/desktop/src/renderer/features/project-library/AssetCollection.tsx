import { useEffect, useMemo, useState } from "react";
import type { DesktopAssetLayoutPreference } from "../../../presentation/presentation-preferences";
import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton } from "../../ui";
import type { AssetBrowserCollectionId, AssetBrowserCollectionState } from "./asset-browser-controller";
import {
    ASSET_KIND_HELP_MESSAGE_IDS,
    ASSET_KIND_MESSAGE_IDS,
    type AssetKindView,
    type AssetTargetSupportView,
} from "./project-library-model";

export type AssetTargetSupportState =
    | { readonly status: "loading" }
    | { readonly status: "unavailable" }
    | {
          readonly status: "ready";
          readonly byKind: ReadonlyMap<AssetKindView, readonly AssetTargetSupportView[]>;
      };

export type AssetRowAction = "metadata" | "copy";

export interface AssetCollectionProps {
    readonly collection: AssetBrowserCollectionState;
    readonly refreshing?: boolean;
    readonly selectedKind?: AssetKindView;
    readonly layout: DesktopAssetLayoutPreference;
    readonly selectedAssetId: string | undefined;
    readonly showTargetSupport?: boolean;
    readonly targetSupport?: AssetTargetSupportState;
    readonly onOpenGuidedImport?: () => void;
    readonly onLoadKind: (collectionId: AssetBrowserCollectionId, kind: AssetKindView) => void;
    readonly onSelectAsset: (assetId: string) => void;
    readonly onOpenAssetAction?: (assetId: string, action: AssetRowAction) => void;
    readonly onAddAssetToTool?: (assetId: string) => void;
}

function AssetTargetSummary({ support }: { readonly support: readonly AssetTargetSupportView[] }): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const [expanded, setExpanded] = useState(false);
    const visibleSupport = expanded ? support : support.slice(0, 3);
    const hiddenSupportCount = support.length - 3;
    return (
        <div
            className="asset-target-summary"
            title={text("library.targets.help", { targets: support.map((target) => target.displayName).join(" · ") })}
        >
            <span className="asset-target-prefix">{text("library.targets.prefix")}</span>
            <span className="asset-target-names">
                {visibleSupport.map((target) => (
                    <span data-oaam-agent-runtime-ids={target.agentRuntimeIds.join(" ")} key={target.key}>
                        {target.displayName}
                    </span>
                ))}
            </span>
            {hiddenSupportCount > 0 ? (
                <button
                    data-oaam-interaction-entry="features.project-library.asset_collection.001"
                    type="button"
                    className="asset-target-more"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((current) => !current)}
                >
                    {text(expanded ? "library.targets.less" : "library.targets.more", { count: hiddenSupportCount })}
                </button>
            ) : null}
        </div>
    );
}

export function AssetCollection({
    collection,
    refreshing = false,
    selectedKind,
    layout,
    selectedAssetId,
    showTargetSupport = false,
    targetSupport,
    onOpenGuidedImport,
    onLoadKind,
    onSelectAsset,
    onOpenAssetAction,
    onAddAssetToTool,
}: AssetCollectionProps): React.JSX.Element {
    const { text, displayText } = useDesktopPresentation();
    const visibleKinds = useMemo(
        () =>
            selectedKind === undefined
                ? collection.kinds.filter((kind) => kind.totalCount > 0)
                : collection.kinds.filter((kind) => kind.kind === selectedKind),
        [collection.kinds, selectedKind],
    );
    const accessibleTitle = text("library.assets.title");

    useEffect(() => {
        for (const kindState of visibleKinds) {
            if (kindState.status === "collapsed") {
                onLoadKind(collection.collectionId, kindState.kind);
            }
        }
    }, [collection.collectionId, onLoadKind, visibleKinds]);

    return (
        <section
            className="asset-collection"
            aria-busy={refreshing}
            aria-label={accessibleTitle}
            data-oaam-collection-id={collection.collectionId}
            data-oaam-total-count={collection.totalCount}
        >
            {visibleKinds.length === 0 || (selectedKind === undefined && collection.totalCount === 0) ? (
                <div className="library-empty-inline asset-collection-empty">
                    <span>{text("library.assets.empty")}</span>
                    {onOpenGuidedImport === undefined ? null : (
                        <button
                            className="library-secondary-button"
                            type="button"
                            data-oaam-action="start-guided-import"
                            data-oaam-semantic-action="library.start_guided_import"
                            data-oaam-semantic-entry="library.guided_import.empty_kind"
                            onClick={() => onOpenGuidedImport()}
                        >
                            {text("library.import_sources")}
                        </button>
                    )}
                </div>
            ) : (
                <div className="asset-kind-groups" data-layout={layout}>
                    {visibleKinds.map((kindState) => {
                        const kindTitleId = `${collection.collectionId}-${kindState.kind}`;
                        const support = targetSupport?.status === "ready" ? (targetSupport.byKind.get(kindState.kind) ?? []) : [];
                        const hiddenSupportCount = Math.max(0, support.length - 3);
                        return (
                            <section
                                className="asset-kind-group"
                                data-oaam-asset-kind={kindState.kind}
                                key={kindState.kind}
                                aria-labelledby={kindTitleId}
                                aria-busy={
                                    kindState.status === "loading" ||
                                    (kindState.status === "ready" && kindState.loadingMore === true)
                                }
                            >
                                <header className="asset-kind-header">
                                    <div className="asset-kind-title">
                                        <h4 id={kindTitleId}>
                                            <span
                                                className="asset-kind-title-label"
                                                title={text(ASSET_KIND_HELP_MESSAGE_IDS[kindState.kind])}
                                            >
                                                {text(ASSET_KIND_MESSAGE_IDS[kindState.kind])}
                                            </span>
                                        </h4>
                                        <span className="library-count">{kindState.totalCount}</span>
                                    </div>
                                    {showTargetSupport ? (
                                        <div
                                            className="asset-target-support"
                                            data-oaam-hidden-target-count={hiddenSupportCount}
                                            data-oaam-target-support-status={targetSupport?.status ?? "loading"}
                                        >
                                            {targetSupport?.status === "ready" ? (
                                                support.length > 0 ? (
                                                    <AssetTargetSummary support={support} />
                                                ) : (
                                                    <span>{text("library.targets.none")}</span>
                                                )
                                            ) : targetSupport?.status === "unavailable" ? (
                                                <span>{text("library.targets.unavailable")}</span>
                                            ) : (
                                                <span>{text("library.targets.loading")}</span>
                                            )}
                                        </div>
                                    ) : null}
                                </header>
                                {kindState.status === "loading" || kindState.status === "collapsed" ? (
                                    <div className="library-empty-inline" role="status" aria-busy="true">
                                        {text("library.assets.loading_page")}
                                    </div>
                                ) : kindState.status === "failed" ? (
                                    <div className="library-empty-inline" role="alert">
                                        <p>{displayText(kindState.message)}</p>
                                        <ProtocolDiagnostics
                                            diagnostics={kindState.diagnostics}
                                            technicalSummary={text("import.ui.technical_details")}
                                        />
                                        <button
                                            data-oaam-interaction-entry="features.project-library.asset_collection.003"
                                            type="button"
                                            onClick={() => onLoadKind(collection.collectionId, kindState.kind)}
                                        >
                                            {text("common.retry")}
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="asset-items" data-layout={layout}>
                                            {kindState.assets.map((asset) => (
                                                <div
                                                    className="asset-library-item"
                                                    data-oaam-asset-id={asset.assetId}
                                                    data-selected={selectedAssetId === asset.assetId}
                                                    data-status={asset.currentVersionStatus}
                                                    data-oaam-revision={asset.currentRevision}
                                                    key={asset.assetId}
                                                >
                                                    <button
                                                        data-oaam-interaction-entry="features.project-library.asset_collection.004"
                                                        data-oaam-action="inspect-asset"
                                                        className="asset-library-item-button"
                                                        type="button"
                                                        onClick={() => onSelectAsset(asset.assetId)}
                                                    >
                                                        <span className="asset-library-main">
                                                            <strong>{asset.displayName}</strong>
                                                            <span>
                                                                {asset.displayDescription ||
                                                                    text("library.assets.no_description")}
                                                            </span>
                                                        </span>
                                                        <span className="asset-library-meta">
                                                            <span className="asset-summary-revision">
                                                                {text("library.assets.revision", {
                                                                    revision: asset.currentRevision,
                                                                })}
                                                            </span>
                                                            {asset.deleted ? (
                                                                <span className="library-warning-badge">
                                                                    {text("library.assets.deleted")}
                                                                </span>
                                                            ) : asset.currentVersionStatus === "incomplete" ? (
                                                                <span className="library-warning-badge">
                                                                    {text("library.assets.incomplete")}
                                                                </span>
                                                            ) : null}
                                                        </span>
                                                    </button>
                                                    {asset.deleted ? null : (
                                                        <fieldset
                                                            className="asset-library-row-actions"
                                                            aria-label={text("library.actions.title")}
                                                        >
                                                            {onAddAssetToTool === undefined ? null : (
                                                                <WorkbenchIconButton
                                                                    icon="import"
                                                                    label={text("library.deployments.start")}
                                                                    data-oaam-semantic-action="library.open_asset_deployment"
                                                                    data-oaam-semantic-entry="library.asset_deployment.row"
                                                                    onClick={() => onAddAssetToTool(asset.assetId)}
                                                                />
                                                            )}
                                                            {onOpenAssetAction === undefined ? null : (
                                                                <>
                                                                    <WorkbenchIconButton
                                                                        data-oaam-interaction-entry="features.project-library.asset_collection.006"
                                                                        icon="edit"
                                                                        label={text("library.metadata.open")}
                                                                        onClick={() =>
                                                                            onOpenAssetAction(asset.assetId, "metadata")
                                                                        }
                                                                    />
                                                                    <WorkbenchIconButton
                                                                        data-oaam-interaction-entry="features.project-library.asset_collection.007"
                                                                        icon="copy"
                                                                        label={text("library.copy.open")}
                                                                        onClick={() => onOpenAssetAction(asset.assetId, "copy")}
                                                                    />
                                                                </>
                                                            )}
                                                        </fieldset>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                        {kindState.hasMore ? (
                                            <button
                                                data-oaam-interaction-entry="features.project-library.asset_collection.008"
                                                className="library-secondary-button show-more-button"
                                                type="button"
                                                disabled={refreshing || kindState.loadingMore}
                                                onClick={() => onLoadKind(collection.collectionId, kindState.kind)}
                                            >
                                                {text("library.assets.show_more", {
                                                    kind: text(ASSET_KIND_MESSAGE_IDS[kindState.kind]),
                                                    count: kindState.totalCount - kindState.assets.length,
                                                })}
                                            </button>
                                        ) : null}
                                    </>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
