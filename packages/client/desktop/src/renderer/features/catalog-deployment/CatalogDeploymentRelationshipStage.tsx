import type { ReactNode } from "react";
import { WorkbenchPanel } from "../../ui";
import { CatalogAssetUsageRelationships, type CatalogAssetUsageRelationshipsProps } from "./CatalogAssetUsageRelationships";
import {
    CatalogDeploymentTargetEmptyState,
    type CatalogDeploymentTargetEmptyStateProps,
} from "./CatalogDeploymentTargetEmptyState";
import type { ProbeReviewView } from "./catalog-deployment-model";

interface CatalogDeploymentRelationshipStageProps extends CatalogAssetUsageRelationshipsProps {
    readonly targetDiscovery?: ReactNode;
    readonly probeReview: ProbeReviewView | undefined;
    readonly subjectKind: CatalogDeploymentTargetEmptyStateProps["subjectKind"];
}

export function CatalogDeploymentRelationshipStage({
    targetDiscovery,
    probeReview,
    subjectKind,
    observations,
    deployments,
    assetId,
    usage,
    providers,
    interactionLocked,
    installationLocationBusy,
    installationRootFailureKey,
    onChooseInstallationRoot,
    onPrepare,
    onOpenUsage,
}: CatalogDeploymentRelationshipStageProps): React.JSX.Element {
    return (
        <>
            {targetDiscovery}
            {probeReview !== undefined && observations.length === 0 ? (
                <WorkbenchPanel surface="section" className="deployment-journey-step" data-oaam-deployment-step="relationships">
                    <CatalogDeploymentTargetEmptyState
                        probeReview={probeReview}
                        providers={providers}
                        subjectKind={subjectKind}
                        installationLocationBusy={installationLocationBusy}
                        installationRootFailureKey={installationRootFailureKey}
                        onChooseInstallationRoot={onChooseInstallationRoot}
                    />
                </WorkbenchPanel>
            ) : probeReview !== undefined || observations.length > 0 || usage.status !== "none" ? (
                <CatalogAssetUsageRelationships
                    observations={observations}
                    deployments={deployments}
                    assetId={assetId}
                    usage={usage}
                    providers={providers}
                    interactionLocked={interactionLocked}
                    installationLocationBusy={installationLocationBusy}
                    installationRootFailureKey={installationRootFailureKey}
                    onChooseInstallationRoot={onChooseInstallationRoot}
                    onPrepare={onPrepare}
                    onOpenUsage={onOpenUsage}
                />
            ) : null}
        </>
    );
}
