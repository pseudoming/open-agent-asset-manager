import { useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton, WorkbenchNotice } from "../../ui";
import { type AdapterProviderView, presentDiscoveryTool } from "../discovery/presentation";
import type { AssetVersionView } from "./catalog-deployment-model";

export interface CatalogAssetSourceInspectorProps {
    readonly importSource: NonNullable<AssetVersionView["importSource"]>;
    readonly providers: readonly AdapterProviderView[];
    readonly onClose: () => void;
}

export interface CatalogAssetSourceDetailsProps {
    readonly importSource: NonNullable<AssetVersionView["importSource"]>;
    readonly providers: readonly AdapterProviderView[];
    readonly revealableSourceRootIds?: readonly string[];
    readonly onRevealSourceRoot?: (sourceRootId: string) => Promise<{ readonly status: "complete" | "failed" }>;
}

function sourceFilePath(rootPath: string, relativePath: string): string {
    const separator = rootPath.includes("\\") ? "\\" : "/";
    const root = rootPath.replace(/[\\/]$/u, "");
    return `${root}${separator}${relativePath.replace(/[\\/]/gu, separator)}`;
}

export function CatalogAssetSourceDetails({
    importSource,
    providers,
    revealableSourceRootIds = [],
    onRevealSourceRoot,
}: CatalogAssetSourceDetailsProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const roots = new Map(importSource.roots.map((root) => [root.sourceRootId, root]));
    const [pathCopyState, setPathCopyState] = useState<
        { readonly path: string; readonly status: "copied" | "failed" } | undefined
    >();
    const [revealState, setRevealState] = useState<
        { readonly sourceRootId: string; readonly status: "opening" | "complete" | "failed" } | undefined
    >();
    const revealableRoots = new Set(revealableSourceRootIds);
    async function copyPath(path: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(path);
            setPathCopyState({ path, status: "copied" });
        } catch {
            setPathCopyState({ path, status: "failed" });
        }
    }
    async function revealRoot(sourceRootId: string): Promise<void> {
        if (!revealableRoots.has(sourceRootId) || onRevealSourceRoot === undefined) return;
        setRevealState({ sourceRootId, status: "opening" });
        try {
            const result = await onRevealSourceRoot(sourceRootId);
            setRevealState({ sourceRootId, status: result.status });
        } catch {
            setRevealState({ sourceRootId, status: "failed" });
        }
    }
    return (
        <div
            className="asset-inspector-scroll catalog-source-detail-list"
            data-oaam-state="ready"
            data-oaam-source-adapter-id={importSource.adapterId}
            data-oaam-source-snapshot-fingerprint={importSource.sourceSnapshotFingerprint}
            data-oaam-source-root-count={importSource.roots.length}
            data-oaam-source-file-count={importSource.files.length}
        >
            <section>
                <h3>
                    {text("catalog.ui.asset.source_locations")} ·{" "}
                    {displayText(presentDiscoveryTool(importSource.adapterId, providers).label)}
                </h3>
                <ul>
                    {importSource.roots.map((root) => (
                        <li
                            key={root.sourceRootId}
                            data-oaam-source-root-id={root.sourceRootId}
                            data-oaam-source-root-role={root.rootRole}
                            data-oaam-source-domain={root.sourceDomain}
                        >
                            <span className="catalog-source-path-row">
                                <code>{root.canonicalPath}</code>
                                <span className="catalog-source-path-actions">
                                    <WorkbenchIconButton
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_source_inspector.002"
                                        icon="copy"
                                        label={text(
                                            pathCopyState?.path === root.canonicalPath
                                                ? pathCopyState.status === "copied"
                                                    ? "discovery.product.scan.path_copied"
                                                    : "discovery.product.scan.path_copy_failed"
                                                : "discovery.product.scan.path_copy",
                                        )}
                                        onClick={() => void copyPath(root.canonicalPath)}
                                    />
                                    {!revealableRoots.has(root.sourceRootId) || onRevealSourceRoot === undefined ? null : (
                                        <WorkbenchIconButton
                                            data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_source_inspector.003"
                                            icon="reveal"
                                            label={text("catalog.ui.target.open_project")}
                                            disabled={
                                                revealState?.sourceRootId === root.sourceRootId &&
                                                revealState.status === "opening"
                                            }
                                            onClick={() => void revealRoot(root.sourceRootId)}
                                        />
                                    )}
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            </section>
            <section>
                <h3>{text("catalog.ui.asset.source_files")}</h3>
                {importSource.files.length === 0 ? (
                    <WorkbenchNotice className="inspector-status">{text("library.inspector.no_files")}</WorkbenchNotice>
                ) : (
                    <ul>
                        {importSource.files.map((file) => {
                            const root = roots.get(file.sourceRootId);
                            const fullPath =
                                root === undefined ? file.relativePath : sourceFilePath(root.canonicalPath, file.relativePath);
                            return (
                                <li
                                    key={`${file.sourceRootId}\0${file.relativePath}`}
                                    data-oaam-source-root-id={file.sourceRootId}
                                    data-oaam-source-relative-path={file.relativePath}
                                    data-oaam-source-content-hash={file.contentHash}
                                    data-oaam-source-full-path={fullPath}
                                >
                                    <span className="catalog-source-path-row">
                                        <code>{fullPath}</code>
                                        <WorkbenchIconButton
                                            data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_source_inspector.004"
                                            icon="copy"
                                            label={text(
                                                pathCopyState?.path === fullPath
                                                    ? pathCopyState.status === "copied"
                                                        ? "discovery.product.scan.path_copied"
                                                        : "discovery.product.scan.path_copy_failed"
                                                    : "discovery.product.scan.path_copy",
                                            )}
                                            onClick={() => void copyPath(fullPath)}
                                        />
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
            {revealState?.status === "complete" ? (
                <WorkbenchNotice role="status">{text("import.ui.inspector.reveal_complete")}</WorkbenchNotice>
            ) : revealState?.status === "failed" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {text("import.ui.inspector.reveal_failed")}
                </WorkbenchNotice>
            ) : null}
        </div>
    );
}

export function CatalogAssetSourceInspector({
    importSource,
    providers,
    onClose,
}: CatalogAssetSourceInspectorProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    return (
        <aside
            className="asset-inspector catalog-asset-source-inspector"
            aria-label={text("catalog.ui.asset.source_details")}
            data-oaam-state="ready"
            data-oaam-source-adapter-id={importSource.adapterId}
            data-oaam-source-snapshot-fingerprint={importSource.sourceSnapshotFingerprint}
            data-oaam-source-root-count={importSource.roots.length}
            data-oaam-source-file-count={importSource.files.length}
        >
            <header className="asset-inspector-header">
                <div>
                    <span>{text("catalog.ui.asset.source_details")}</span>
                    <h2>{displayText(presentDiscoveryTool(importSource.adapterId, providers).label)}</h2>
                </div>
                <WorkbenchIconButton
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_source_inspector.001"
                    className="library-icon-button"
                    icon="close"
                    label={text("library.inspector.close")}
                    onClick={onClose}
                />
            </header>
            <CatalogAssetSourceDetails importSource={importSource} providers={providers} />
        </aside>
    );
}
