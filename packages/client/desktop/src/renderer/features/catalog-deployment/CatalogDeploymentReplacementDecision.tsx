import { useEffect, useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchDialog } from "../../ui";
import type { RenderPreviewView } from "./catalog-deployment-model";
import {
    PREVIEW_DIRECTORY_CHANGE_MESSAGES,
    previewEntryIsUnchanged,
    previewFileChangeMessage,
    previewGraphPathLabels,
} from "./render-review-presentation";

/** Mounted with the exact preview key; a new preview never inherits confirmation. */
export function CatalogDeploymentReplacementDecision({
    preview,
    targetLabel,
    targetPath,
    disabled,
    onConfirm,
}: {
    readonly preview: RenderPreviewView;
    readonly targetLabel: string;
    readonly targetPath: string;
    readonly disabled: boolean;
    readonly onConfirm: () => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const [open, setOpen] = useState(false);
    const unmanaged = preview.actionState === "requires_unmanaged_replacement";
    const paths = previewGraphPathLabels(preview);
    const graph = preview.directories.length > 0;
    const entries = [
        ...preview.files.map((file) => ({
            key: `file:${file.relativePath}`,
            relativePath: file.relativePath,
            label: paths.label(file.relativePath),
            unchanged: previewEntryIsUnchanged(file),
            message:
                file.changeKind === "establish_baseline"
                    ? ("catalog.ui.preview.change.unchanged" as const)
                    : previewFileChangeMessage(file),
        })),
        ...preview.directories.map((directory) => ({
            key: `directory:${directory.relativePath}`,
            relativePath: directory.relativePath,
            label: `${paths.label(directory.relativePath)}/`,
            unchanged: previewEntryIsUnchanged(directory),
            message: PREVIEW_DIRECTORY_CHANGE_MESSAGES[directory.changeKind],
        })),
    ];
    const changed = entries.filter((entry) => !entry.unchanged);
    const unchanged = entries.filter((entry) => entry.unchanged);
    function entryList(rows: typeof entries): React.JSX.Element {
        return (
            <ul className="catalog-replacement-paths">
                {rows.map((entry) => (
                    <li key={entry.key} data-oaam-reviewed-relative-path={entry.relativePath}>
                        <strong>{entry.label}</strong>
                        <span>{text(entry.message)}</span>
                    </li>
                ))}
            </ul>
        );
    }
    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);
    function confirmReplacementDeployment(): void {
        if (!open || disabled) return;
        setOpen(false);
        onConfirm();
    }
    return (
        <div className="catalog-preview-decision-actions">
            <button
                data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_replacement_decision.001"
                data-oaam-replacement-action="review"
                type="button"
                disabled={disabled}
                onClick={() => setOpen(true)}
            >
                {text(unmanaged ? "catalog.ui.action.replace_unmanaged" : "catalog.ui.action.overwrite")}
            </button>
            {open ? (
                <WorkbenchDialog
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_replacement_decision.002"
                    dialogId="deployment_replacement"
                    className="catalog-replacement-dialog"
                    title={text(
                        graph
                            ? unmanaged
                                ? "catalog.product.replace.graph_title"
                                : "catalog.product.overwrite.graph_title"
                            : unmanaged
                              ? "catalog.product.replace.title"
                              : "catalog.product.overwrite.title",
                    )}
                    closeLabel={text("common.cancel")}
                    onClose={() => setOpen(false)}
                >
                    <div className="catalog-replacement-subject">
                        <p>{targetLabel}</p>
                        <p className="catalog-replacement-target">{targetPath}</p>
                        {paths.root === undefined ? null : <p className="catalog-replacement-target">{paths.root}/</p>}
                    </div>
                    <div className="catalog-replacement-review">
                        <p>{text(unmanaged ? "catalog.product.replace.effect" : "catalog.product.overwrite.effect")}</p>
                        {entryList(changed)}
                        {unchanged.length === 0 ? null : (
                            <details className="catalog-replacement-unchanged">
                                <summary data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_replacement_decision.005">
                                    {text("catalog.product.replace.unchanged", { count: unchanged.length })}
                                </summary>
                                {entryList(unchanged)}
                            </details>
                        )}
                    </div>
                    <div className="workbench-dialog-actions">
                        <button
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_replacement_decision.003"
                            type="button"
                            className="library-secondary-button"
                            onClick={() => setOpen(false)}
                        >
                            {text("common.cancel")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_replacement_decision.004"
                            data-oaam-replacement-action="confirm"
                            type="button"
                            disabled={disabled}
                            onClick={confirmReplacementDeployment}
                        >
                            {text("catalog.product.replace.confirm")}
                        </button>
                    </div>
                </WorkbenchDialog>
            ) : null}
        </div>
    );
}
