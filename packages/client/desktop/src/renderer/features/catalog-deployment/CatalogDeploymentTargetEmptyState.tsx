import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import { type DesktopMessageId, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice } from "../../ui";
import {
    deriveDiscoveryEnvironmentProbeOutcomes,
    discoveryToolOutcomeMessage,
    presentDiscoveryEnvironment,
    presentDiscoveryTool,
    type AdapterProviderView,
} from "../discovery/presentation";
import type { DeploymentWorkspaceSubject, ProbeReviewView } from "./catalog-deployment-model";

export interface CatalogDeploymentTargetEmptyStateProps {
    readonly probeReview: ProbeReviewView;
    readonly providers: readonly AdapterProviderView[];
    readonly subjectKind: DeploymentWorkspaceSubject["subjectKind"];
    readonly installationLocationBusy?: boolean;
    readonly installationRootFailureKey?: string;
    readonly onChooseInstallationRoot?: (
        adapterId: string,
        environment: ProbeReviewView["results"][number]["environment"],
    ) => void;
}

function availableWithoutTargetMessage(subjectKind: DeploymentWorkspaceSubject["subjectKind"]): DesktopMessageId {
    return subjectKind === "project"
        ? "catalog.ui.create.no_target.available_project"
        : "catalog.ui.create.no_target.available_global";
}

export function CatalogDeploymentTargetEmptyState({
    probeReview,
    providers,
    subjectKind,
    installationLocationBusy = false,
    installationRootFailureKey = "",
    onChooseInstallationRoot,
}: CatalogDeploymentTargetEmptyStateProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const outcomes = deriveDiscoveryEnvironmentProbeOutcomes(probeReview);
    const tools = outcomes.flatMap((outcome) => outcome.tools.map((tool) => ({ environment: outcome.environment, tool })));

    return (
        <WorkbenchNotice
            className="deployment-target-empty-state"
            data-oaam-target-empty-state={subjectKind}
            role="status"
            tone="empty"
        >
            <strong>{text("catalog.ui.create.no_target.title")}</strong>
            <p>
                {text(
                    subjectKind === "project"
                        ? "catalog.ui.create.no_target.copy_project"
                        : "catalog.ui.create.no_target.copy_global",
                )}
            </p>
            {tools.length === 0 ? (
                <p>{text("catalog.ui.create.no_target.no_result")}</p>
            ) : (
                <ul className="discovery-tool-result-list">
                    {tools.map(({ environment, tool }) => {
                        const key = `${desktopEnvironmentKey(environment)}\0${tool.adapterId}`;
                        const reason =
                            tool.status === "complete" && tool.installationStatus === "available"
                                ? availableWithoutTargetMessage(subjectKind)
                                : discoveryToolOutcomeMessage(tool.status, tool.installationStatus);
                        return (
                            <li key={key}>
                                <strong>
                                    {displayText(presentDiscoveryTool(tool.adapterId, providers).label)} ·{" "}
                                    {displayText(presentDiscoveryEnvironment(environment))}
                                </strong>
                                <span>{text(reason)}</span>
                                {tool.installationStatus === "available" || onChooseInstallationRoot === undefined ? null : (
                                    <button
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_target_empty_state.001"
                                        type="button"
                                        className="library-secondary-button"
                                        disabled={installationLocationBusy}
                                        onClick={() => onChooseInstallationRoot(tool.adapterId, environment)}
                                    >
                                        {text("catalog.ui.target.choose_installation")}
                                    </button>
                                )}
                                {installationRootFailureKey === key ? (
                                    <span role="alert">{text("catalog.ui.target.installation_picker_failed")}</span>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </WorkbenchNotice>
    );
}
