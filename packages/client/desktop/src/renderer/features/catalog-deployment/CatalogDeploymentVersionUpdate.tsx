import { useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchConfirmation, WorkbenchPanel, WorkbenchTechnicalFact } from "../../ui";
import type { CatalogDeploymentController, CatalogDeploymentState } from "./catalog-deployment-controller";
import type { DeploymentAssetSelection, DeploymentView } from "./catalog-deployment-model";

interface CatalogDeploymentVersionUpdateProps {
    readonly controller: CatalogDeploymentController;
    readonly state: Extract<CatalogDeploymentState, { readonly status: "ready" }>;
    readonly deployment: DeploymentView | undefined;
    readonly assetId?: string;
    readonly assetSelection?: DeploymentAssetSelection;
    readonly disabled: boolean;
}

export function CatalogDeploymentVersionUpdate({
    controller,
    state,
    deployment,
    assetId,
    assetSelection,
    disabled,
}: CatalogDeploymentVersionUpdateProps) {
    const { text } = useDesktopPresentation();
    const [consents, setConsents] = useState<readonly string[]>([]);
    if (
        deployment === undefined ||
        deployment.deleted ||
        deployment.actionHints.some((hint) => hint === "recover" || hint === "contact_support")
    )
        return null;
    const updates = deployment.assets.flatMap((selected) => {
        if (assetId !== undefined && selected.assetId !== assetId) return [];
        const asset = state.assets.find((value) => value.assetId === selected.assetId && !value.deleted);
        return asset === undefined || asset.currentVersionId === selected.versionId ? [] : [{ asset, selected }];
    });
    if (updates.length === 0 || !controller.supportsVersionUpdate) return null;
    const locked = disabled || state.stale || state.requiresReconciliation;
    return (
        <WorkbenchPanel surface="section" className="deployment-journey-step" data-oaam-version-update>
            <h2>{text("catalog.version_update.title")}</h2>
            <p className="section-copy">{text("catalog.version_update.copy")}</p>
            <p>{text("catalog.ui.outcome.location", { path: deployment.targetRootPath })}</p>
            {updates.map(({ asset, selected }) => {
                const key = `${deployment.deploymentId}:${asset.assetId}:${asset.currentVersionId}`;
                const allowIncomplete =
                    assetId === undefined
                        ? consents.includes(key)
                        : assetSelection?.assetId === asset.assetId &&
                          assetSelection.versionId === asset.currentVersionId &&
                          assetSelection.allowIncomplete;
                return (
                    <div key={key} data-oaam-version-update-asset={asset.assetId}>
                        <WorkbenchTechnicalFact
                            fact={
                                <strong>
                                    {text("catalog.ui.create.asset_revision", {
                                        asset: asset.displayName,
                                        revision: asset.currentRevision,
                                    })}
                                </strong>
                            }
                            summary={text("import.ui.technical_details")}
                        >
                            <p>{text("catalog.version_update.selected", { version: selected.versionId })}</p>
                            <p>{text("catalog.version_update.next", { version: asset.currentVersionId })}</p>
                        </WorkbenchTechnicalFact>
                        {asset.currentVersionStatus === "incomplete" && assetId === undefined ? (
                            <WorkbenchConfirmation
                                data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_version_update.001"
                                checked={allowIncomplete}
                                disabled={locked}
                                onCheckedChange={(checked) =>
                                    setConsents((current) =>
                                        checked ? [...current, key] : current.filter((value) => value !== key),
                                    )
                                }
                            >
                                {text("catalog.ui.create.allow_incomplete")}
                            </WorkbenchConfirmation>
                        ) : null}
                        <button
                            type="button"
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_version_update.002"
                            data-oaam-deployment-action="update-version"
                            disabled={locked || (asset.currentVersionStatus === "incomplete" && !allowIncomplete)}
                            onClick={() =>
                                void controller.updateVersion({
                                    deploymentId: deployment.deploymentId,
                                    assetId: asset.assetId,
                                    previousVersionId: selected.versionId,
                                    versionId: asset.currentVersionId,
                                    allowIncomplete: asset.currentVersionStatus === "incomplete" && allowIncomplete,
                                })
                            }
                        >
                            {text("catalog.version_update.choose", { revision: asset.currentRevision })}
                        </button>
                    </div>
                );
            })}
        </WorkbenchPanel>
    );
}
