import { useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice } from "../../ui";
import type { AdapterProviderView, ProbeEnvironmentReferenceView } from "./discovery-model";
import { focusDiscoveryEnvironmentChoices } from "./DiscoverySetupChoices";

export interface DiscoveryEnvironmentReferenceNoticesProps {
    readonly providers: readonly AdapterProviderView[];
    readonly references: readonly ProbeEnvironmentReferenceView[];
    readonly onChooseEnvironments?: () => void;
    readonly disabled?: boolean;
}

export function DiscoveryEnvironmentReferenceNotices({
    providers,
    references,
    onChooseEnvironments,
    disabled,
}: DiscoveryEnvironmentReferenceNoticesProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <>
            {references.map((reference) => {
                const runtimeDisplayName =
                    providers
                        .flatMap((provider) => provider.agentRuntimes)
                        .find((runtime) => runtime.agentRuntimeId === reference.agentRuntimeId)?.displayName ??
                    reference.agentRuntimeId;
                return (
                    <WorkbenchNotice
                        key={`${reference.adapterId}\0${reference.agentRuntimeId}\0${reference.referencedEnvironment.platformInstanceId}`}
                        data-oaam-reference-kind={reference.referenceKind}
                        data-oaam-reference-state={reference.validationState}
                        data-oaam-reference-runtime-id={reference.agentRuntimeId}
                        data-oaam-reference-origin-platform={reference.originEnvironment.platform}
                        data-oaam-reference-origin-instance={reference.originEnvironment.platformInstanceId}
                        data-oaam-reference-target-platform={reference.referencedEnvironment.platform}
                        data-oaam-reference-target-instance={reference.referencedEnvironment.platformInstanceId}
                        role="status"
                    >
                        {text("discovery.ui.unchecked_project_environment_reference", {
                            runtime: runtimeDisplayName,
                            environment: reference.referencedEnvironment.platformInstanceId,
                        })}
                    </WorkbenchNotice>
                );
            })}
            {references.length === 0 ? null : (
                <button
                    type="button"
                    className="library-secondary-button"
                    data-oaam-interaction-entry="features.discovery.discovery_environment_reference_notices.001"
                    disabled={disabled}
                    onClick={onChooseEnvironments ?? focusDiscoveryEnvironmentChoices}
                >
                    {text("discovery.ui.choose_environments")}
                </button>
            )}
        </>
    );
}
