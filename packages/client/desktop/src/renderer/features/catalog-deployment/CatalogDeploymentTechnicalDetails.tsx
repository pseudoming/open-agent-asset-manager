import type { ReactNode } from "react";
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchTechnicalFact } from "../../ui";

interface EnvironmentIdentity {
    readonly platform: string;
    readonly platformInstanceId: string;
}

function environmentIdentity(environment: EnvironmentIdentity): string {
    return `${environment.platform}:${environment.platformInstanceId}`;
}

export interface CatalogTargetTechnicalDetailsProps {
    readonly fact: ReactNode;
    readonly adapterId: string;
    readonly environment: EnvironmentIdentity;
    readonly agentRuntimeIds: readonly string[];
    readonly displayPath?: string;
    readonly checkedPaths?: readonly string[];
    readonly failureStages?: readonly string[];
}

export function CatalogTargetTechnicalDetails({
    fact,
    adapterId,
    environment,
    agentRuntimeIds,
    displayPath,
    checkedPaths = [],
    failureStages = [],
}: CatalogTargetTechnicalDetailsProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <WorkbenchTechnicalFact
            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_technical_details.001"
            fact={fact}
            summary={text("import.ui.technical_details")}
        >
            <code>{text("catalog.product.technical.target", { id: adapterId })}</code>
            <code>
                {text("catalog.product.technical.environment", {
                    identity: environmentIdentity(environment),
                })}
            </code>
            <code>{text("catalog.product.technical.runtime_ids", { ids: agentRuntimeIds.join(", ") })}</code>
            {displayPath === undefined ? null : <code>{text("discovery.product.technical.path", { path: displayPath })}</code>}
            {checkedPaths.map((path) => (
                <code key={path} data-oaam-checked-path={path}>
                    {text("catalog.ui.usage.checked_path", { path })}
                </code>
            ))}
            {failureStages.length === 0 ? null : (
                <code data-oaam-failure-stages={failureStages.join(" ")}>
                    {text("catalog.ui.usage.failure_stage", { stage: failureStages.join(", ") })}
                </code>
            )}
        </WorkbenchTechnicalFact>
    );
}

export interface CatalogDeploymentTechnicalDetailsProps {
    readonly fact: ReactNode;
    readonly deploymentId: string;
    readonly environment: EnvironmentIdentity;
    readonly agentRuntimeIds: readonly string[];
    readonly targetRootPath?: string;
}

export function CatalogDeploymentTechnicalDetails({
    fact,
    deploymentId,
    environment,
    agentRuntimeIds,
    targetRootPath,
}: CatalogDeploymentTechnicalDetailsProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <WorkbenchTechnicalFact
            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_technical_details.002"
            fact={fact}
            summary={text("import.ui.technical_details")}
        >
            <code>{text("catalog.product.technical.deployment_id", { id: deploymentId })}</code>
            <code>
                {text("catalog.product.technical.environment", {
                    identity: environmentIdentity(environment),
                })}
            </code>
            <code>{text("catalog.product.technical.runtime_ids", { ids: agentRuntimeIds.join(", ") })}</code>
            {targetRootPath === undefined ? null : (
                <code>{text("discovery.product.technical.path", { path: targetRootPath })}</code>
            )}
        </WorkbenchTechnicalFact>
    );
}

export interface CatalogActivityTechnicalDetailsProps {
    readonly fact: ReactNode;
    readonly operationId?: string;
    readonly progressStage?: string;
}

export function CatalogActivityTechnicalDetails({
    fact,
    operationId,
    progressStage,
}: CatalogActivityTechnicalDetailsProps): React.JSX.Element | null {
    const { text } = useDesktopPresentation();
    if (operationId === undefined && progressStage === undefined) return null;
    return (
        <WorkbenchTechnicalFact
            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_technical_details.003"
            fact={fact}
            summary={text("import.ui.technical_details")}
        >
            {operationId === undefined ? null : (
                <code>{text("catalog.product.technical.operation_id", { id: operationId })}</code>
            )}
            {progressStage === undefined ? null : (
                <code>{text("catalog.product.technical.progress_stage", { stage: progressStage })}</code>
            )}
        </WorkbenchTechnicalFact>
    );
}

export interface CatalogReasonTechnicalDetailsProps {
    readonly fact: ReactNode;
    readonly reason: string;
}

export function CatalogReasonTechnicalDetails({ fact, reason }: CatalogReasonTechnicalDetailsProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <WorkbenchTechnicalFact
            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_technical_details.004"
            fact={fact}
            summary={text("import.ui.technical_details")}
        >
            <code>{text("catalog.product.technical.reason", { reason })}</code>
        </WorkbenchTechnicalFact>
    );
}
