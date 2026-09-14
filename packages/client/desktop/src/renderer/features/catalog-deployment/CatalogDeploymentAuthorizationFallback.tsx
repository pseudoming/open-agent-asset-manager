import { useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice } from "../../ui";
import type {
    AssetSummaryView,
    DeploymentView,
    DeploymentWorkspaceSubject,
    RenderAnalysisView,
} from "./catalog-deployment-model";

interface CatalogDeploymentAuthorizationFallbackProps {
    readonly subject: DeploymentWorkspaceSubject;
    readonly asset: AssetSummaryView | undefined;
    readonly deployment: DeploymentView;
    readonly analysis: RenderAnalysisView | undefined;
    readonly disabled: boolean;
    readonly onRetry: () => void;
    readonly onOpenAssetUsage?: (assetId: string) => void;
    readonly onOpenLibrary?: () => void;
}

export function CatalogDeploymentAuthorizationFallback({
    subject,
    asset,
    deployment,
    analysis,
    disabled,
    onRetry,
    onOpenAssetUsage,
    onOpenLibrary,
}: CatalogDeploymentAuthorizationFallbackProps): React.JSX.Element | null {
    const { text } = useDesktopPresentation();
    if (analysis?.deploymentId !== deployment.deploymentId) return null;
    const inspections = analysis.promotionAuthorizationInspections;
    const required = inspections.some((inspection) => inspection.promotionAuthorizationState === "required");
    const unavailable = inspections.some((inspection) => inspection.promotionAuthorizationState === "unavailable");
    if (!required && !unavailable) return null;
    const inspection = inspections.length === 1 ? inspections[0] : undefined;
    // This is navigation eligibility, never permission to create a grant. The existing usage
    // journey must still check the tool and pass its exact current-Version/target guard.
    const currentProjectVersion =
        subject.subjectKind === "project" &&
        deployment.subject.subjectKind === "project" &&
        deployment.subject.projectId === subject.projectId &&
        !deployment.deleted &&
        deployment.consumerAgentRuntimeIds.length === 1 &&
        asset !== undefined &&
        !asset.deleted &&
        asset.scope === "project" &&
        asset.projectId === subject.projectId &&
        deployment.assets.length === 1 &&
        deployment.assets[0]?.assetId === asset.assetId &&
        deployment.assets[0]?.versionId === asset.currentVersionId &&
        inspection?.assetId === asset.assetId &&
        inspection.versionId === asset.currentVersionId &&
        inspection.target.targetKind === "project" &&
        inspection.target.projectId === subject.projectId;
    return (
        <WorkbenchNotice
            data-oaam-promotion-authorization={required ? "required" : "unavailable"}
            tone={unavailable ? "danger" : "warning"}
            role={unavailable ? "alert" : "status"}
        >
            {required ? (
                <>
                    {currentProjectVersion ? (
                        <p>
                            <strong>{asset.displayName}</strong> ·{" "}
                            {text("catalog.product.asset.revision", { revision: asset.currentRevision })}
                        </p>
                    ) : null}
                    <p>
                        {text(
                            currentProjectVersion
                                ? "catalog.authorization.required"
                                : "catalog.authorization.saved_versions_required",
                        )}
                    </p>
                    <p>
                        {text(
                            currentProjectVersion
                                ? "catalog.authorization.check_tools_first"
                                : "catalog.authorization.review_saved_versions",
                        )}
                    </p>
                    {currentProjectVersion && onOpenAssetUsage !== undefined ? (
                        <button
                            type="button"
                            className="library-secondary-button"
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_authorization_fallback.001"
                            data-oaam-semantic-action="deployment.open_asset_usage"
                            data-oaam-semantic-entry="deployment.authorization.asset_usage"
                            disabled={disabled}
                            onClick={() => onOpenAssetUsage(asset.assetId)}
                        >
                            {text("catalog.authorization.open_asset_usage")}
                        </button>
                    ) : !currentProjectVersion && onOpenLibrary !== undefined ? (
                        <button
                            type="button"
                            className="library-secondary-button"
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_authorization_fallback.002"
                            data-oaam-semantic-action="deployment.open_library"
                            data-oaam-semantic-entry="deployment.authorization.library"
                            disabled={disabled}
                            onClick={() => onOpenLibrary()}
                        >
                            {text("catalog.ui.workspace.back")}
                        </button>
                    ) : null}
                </>
            ) : null}
            {unavailable ? (
                <>
                    <p>{text("catalog.authorization.check_failed")}</p>
                    <button
                        type="button"
                        className="library-secondary-button"
                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_authorization_fallback.003"
                        disabled={disabled}
                        onClick={onRetry}
                    >
                        {text("common.retry")}
                    </button>
                </>
            ) : null}
        </WorkbenchNotice>
    );
}
