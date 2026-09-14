import { projectDisplayName } from "../../presentation/project-label";
import type { ReactNode } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice, WorkbenchRadioButton } from "../../ui";
import { type AdapterProviderView, presentDiscoveryEnvironment } from "../discovery/presentation";
import { catalogCreationRuntimeLabel } from "./CatalogAssetUsageRelationships";
import { CatalogDeploymentTechnicalDetails } from "./CatalogDeploymentTechnicalDetails";
import {
    type AssetSummaryView,
    type DeploymentTargetView,
    type DeploymentView,
    deploymentFreshnessLabel,
    deploymentStatusMessage,
    deploymentTargetForDeployment,
} from "./catalog-deployment-model";
import { deploymentAssetVersionLabels } from "./render-review-presentation";

interface CatalogDeploymentListProps {
    readonly selectedActions?: ReactNode;
    readonly deployments: readonly DeploymentView[];
    readonly targets: readonly DeploymentTargetView[];
    readonly providers: readonly AdapterProviderView[];
    readonly assets: readonly AssetSummaryView[];
    readonly projects: readonly Readonly<{ projectId: string; displayName: string; rootPath?: string }>[];
    readonly selectedDeploymentId: string;
    readonly previousObservationDeploymentId?: string;
    readonly disabled: boolean;
    readonly onSelect: (deploymentId: string) => void;
}

export function CatalogDeploymentList({
    selectedActions,
    deployments,
    targets,
    providers,
    assets,
    projects,
    selectedDeploymentId,
    previousObservationDeploymentId,
    disabled,
    onSelect,
}: CatalogDeploymentListProps): React.JSX.Element {
    const { displayText, snapshot, text } = useDesktopPresentation();
    return (
        <>
            {deployments.length === 0 ? (
                <WorkbenchNotice tone="empty">{text("catalog.ui.deployment.empty")}</WorkbenchNotice>
            ) : (
                <ul className="deployment-list">
                    {deployments.map((deployment) => {
                        const previousObservation = previousObservationDeploymentId === deployment.deploymentId;
                        const target = deploymentTargetForDeployment(targets, deployment);
                        const projectId = deployment.subject.subjectKind === "project" ? deployment.subject.projectId : undefined;
                        const runtimeLabels = deployment.consumerAgentRuntimeIds.map((agentRuntimeId) =>
                            catalogCreationRuntimeLabel(target, agentRuntimeId, providers, {
                                displayText,
                                text,
                            }),
                        );
                        const assetLabel =
                            deploymentAssetVersionLabels(deployment, assets, text).join(", ") ||
                            text("catalog.ui.deployment.asset_count.many", { count: 0 });
                        return (
                            <li
                                key={deployment.deploymentId}
                                data-oaam-deployment-entry
                                data-oaam-deployment-stage={deployment.stage}
                                data-oaam-deployment-observation={previousObservation ? "previous" : "saved"}
                                data-oaam-target-key={target?.key}
                                data-oaam-runtime-versions={JSON.stringify(
                                    deployment.consumerAgentRuntimeIds.map((agentRuntimeId) =>
                                        target === undefined
                                            ? ""
                                            : (target.runtimeIdentities.find(
                                                  (identity) => identity.agentRuntimeId === agentRuntimeId,
                                              )?.versionText ?? ""),
                                    ),
                                )}
                            >
                                <WorkbenchRadioButton
                                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.006"
                                    data-oaam-deployment-action="select"
                                    checked={selectedDeploymentId === deployment.deploymentId}
                                    disabled={disabled}
                                    name="catalog-deployment-selection"
                                    value={deployment.deploymentId}
                                    onCheckedChange={() => onSelect(deployment.deploymentId)}
                                >
                                    <strong>
                                        {previousObservation
                                            ? text("catalog.ui.outcome.previous_observation", { observation: assetLabel })
                                            : assetLabel}
                                    </strong>
                                    <span>{text(deploymentStatusMessage(deployment))}</span>
                                </WorkbenchRadioButton>
                                <div className="deployment-list-metadata">
                                    <small>{text("catalog.ui.outcome.location", { path: deployment.targetRootPath })}</small>
                                    <small>
                                        {projectId !== undefined
                                            ? (projectDisplayName(projects.find((project) => project.projectId === projectId)) ??
                                              deployment.targetRootPath)
                                            : text("library.subject.global")}
                                    </small>
                                    <small>
                                        {displayText(presentDiscoveryEnvironment(deployment.environment))} ·{" "}
                                        {runtimeLabels.join(", ")}
                                    </small>
                                    <CatalogDeploymentTechnicalDetails
                                        deploymentId={deployment.deploymentId}
                                        environment={deployment.environment}
                                        fact={
                                            <small className="deployment-list-freshness">
                                                {deploymentFreshnessLabel(deployment, snapshot.resolvedLocale, text)}
                                            </small>
                                        }
                                        agentRuntimeIds={deployment.consumerAgentRuntimeIds}
                                        targetRootPath={deployment.targetRootPath}
                                    />
                                </div>
                                {selectedDeploymentId === deployment.deploymentId ? selectedActions : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </>
    );
}
