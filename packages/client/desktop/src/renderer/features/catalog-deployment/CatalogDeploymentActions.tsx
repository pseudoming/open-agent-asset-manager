import { useDesktopPresentation } from "../../presentation";
import { DesktopIcon, WorkbenchNotice } from "../../ui";
import type { CatalogDeploymentController } from "./catalog-deployment-controller";
import type { DeploymentView } from "./catalog-deployment-model";

export function CatalogDeploymentActions({
    controller,
    deployment,
    creation,
    analysisFailed,
    primaryAction,
    canReview,
    canCheck,
    canInspect,
    canRecover,
    disabled,
    stale,
}: {
    readonly controller: CatalogDeploymentController;
    readonly deployment: DeploymentView | undefined;
    readonly creation: boolean;
    readonly analysisFailed: boolean;
    readonly primaryAction: string | undefined;
    readonly canReview: boolean;
    readonly canCheck: boolean;
    readonly canInspect: boolean;
    readonly canRecover: boolean;
    readonly disabled: boolean;
    readonly stale: boolean;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    if (deployment === undefined) return <WorkbenchNotice>{text("catalog.ui.deployment.select")}</WorkbenchNotice>;
    return (
        <div className="deployment-actions">
            {canReview && (!creation || analysisFailed) ? (
                <button
                    type="button"
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.007"
                    data-oaam-deployment-action="analyze"
                    className={primaryAction === "analyze" ? undefined : "library-secondary-button"}
                    disabled={disabled || stale}
                    onClick={() => void controller.analyze(deployment.deploymentId)}
                >
                    <DesktopIcon name="preview" size={16} />
                    {text(creation ? "catalog.product.action.check_files" : "catalog.ui.action.analyze")}
                </button>
            ) : null}
            {!creation && canCheck ? (
                <button
                    type="button"
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.008"
                    data-oaam-deployment-action="scan"
                    className={primaryAction === "scan" ? undefined : "library-secondary-button"}
                    disabled={disabled || stale}
                    onClick={() => void controller.scan(deployment.deploymentId)}
                >
                    {text("catalog.ui.action.scan")}
                </button>
            ) : null}
            {!creation && canInspect ? (
                <button
                    type="button"
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.009"
                    data-oaam-deployment-action="inspect"
                    className={primaryAction === "inspect" ? undefined : "library-secondary-button"}
                    disabled={disabled || stale}
                    onClick={() => void controller.inspect(deployment.deploymentId)}
                >
                    <DesktopIcon name="preview" size={16} />
                    {text("catalog.ui.action.inspect")}
                </button>
            ) : null}
            {!creation && canRecover ? (
                <button
                    type="button"
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.010"
                    data-oaam-deployment-action="recover"
                    className={primaryAction === "recover" ? undefined : "library-secondary-button"}
                    disabled={disabled}
                    onClick={() => void controller.recover(deployment.deploymentId)}
                >
                    {text("catalog.ui.action.recover")}
                </button>
            ) : null}
        </div>
    );
}
