import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice, WorkbenchSelectableCard } from "../../ui";
import type { DiscoveryController, DiscoveryState } from "./discovery-controller";
import { presentDiscoveryEnvironment, presentDiscoveryTool } from "./discovery-presentation";
import { discoveryEnvironmentHintMessage, discoveryEnvironmentKey } from "./discovery-workspace-model";

type ReadyDiscoveryState = Extract<DiscoveryState, { readonly status: "ready" }>;

const ENVIRONMENT_CHOICES_ID = "oaam-discovery-environments";
/** Settings keeps choices on this page; navigating to them grants no new scan authority. */
export function focusDiscoveryEnvironmentChoices(): void {
    const choices = document.getElementById(ENVIRONMENT_CHOICES_ID);
    choices?.focus();
    choices?.scrollIntoView?.({ block: "start" });
}

interface DiscoverySetupChoicesProps {
    readonly busy: boolean;
    readonly controller: DiscoveryController;
    readonly state: ReadyDiscoveryState;
}

export function DiscoveryEnvironmentChoices({ busy, controller, state }: DiscoverySetupChoicesProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    return (
        <fieldset id={ENVIRONMENT_CHOICES_ID} tabIndex={-1} className="environment-grid" disabled={busy}>
            <legend>{text("discovery.ui.environment.legend")}</legend>
            {state.environments.map((environment) => {
                const key = discoveryEnvironmentKey(environment.environment);
                const selected = state.selectedEnvironmentKeys.includes(key);
                const selectable = controller.isEnvironmentSelectable(key);
                return (
                    <WorkbenchSelectableCard
                        data-oaam-interaction-entry="features.discovery.discovery_setup_choices.001"
                        selected={selected}
                        className="environment-card"
                        disabled={busy || !selectable}
                        tooltip={
                            controller.projectEnvironmentConstrained && !selectable
                                ? text("discovery.ui.environment.project_mismatch_tooltip")
                                : undefined
                        }
                        data-oaam-environment-instance={environment.environment.platformInstanceId}
                        data-oaam-environment-platform={environment.environment.platform}
                        key={key}
                        selectionMode={controller.projectEnvironmentConstrained ? "single" : "multiple"}
                        selectionName={controller.projectEnvironmentConstrained ? "project-environment" : undefined}
                        onSelectedChange={() => controller.toggleEnvironment(key)}
                    >
                        <span>
                            <strong>{displayText(presentDiscoveryEnvironment(environment.environment))}</strong>
                            <small>
                                {text(
                                    controller.projectEnvironmentConstrained
                                        ? selectable
                                            ? controller.projectEnvironmentNeedsChoice
                                                ? "discovery.ui.environment.project_choose"
                                                : "discovery.ui.environment.project_match"
                                            : "discovery.ui.environment.project_mismatch"
                                        : discoveryEnvironmentHintMessage(environment.environment.platform),
                                )}
                            </small>
                        </span>
                    </WorkbenchSelectableCard>
                );
            })}
        </fieldset>
    );
}

export function DiscoveryToolChoices({ busy, controller, state }: DiscoverySetupChoicesProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const knownProviderIds = new Set(state.providers.map((provider) => provider.adapterId));
    const unavailableProviderIds = state.selectedAdapterIds.filter((adapterId) => !knownProviderIds.has(adapterId));
    return (
        <>
            <div className="provider-grid">
                {state.providers.map((provider) => {
                    const checked = state.selectedAdapterIds.includes(provider.adapterId);
                    return (
                        <WorkbenchSelectableCard
                            data-oaam-interaction-entry="features.discovery.discovery_setup_choices.002"
                            selected={checked}
                            className="provider-card"
                            data-oaam-provider-id={provider.adapterId}
                            disabled={busy}
                            key={provider.adapterId}
                            onSelectedChange={() => controller.toggleProvider(provider.adapterId)}
                        >
                            <strong>{displayText(presentDiscoveryTool(provider.adapterId, state.providers).label)}</strong>
                        </WorkbenchSelectableCard>
                    );
                })}
                {unavailableProviderIds.map((adapterId) => (
                    <WorkbenchSelectableCard
                        data-oaam-interaction-entry="features.discovery.discovery_setup_choices.003"
                        selected
                        className="provider-card provider-card-warning"
                        data-oaam-provider-id={adapterId}
                        disabled={busy}
                        key={adapterId}
                        onSelectedChange={() => controller.toggleProvider(adapterId)}
                    >
                        <span>
                            <strong>{displayText(presentDiscoveryTool(adapterId, state.providers).label)}</strong>
                            <small>{text("discovery.ui.provider.unavailable")}</small>
                        </span>
                    </WorkbenchSelectableCard>
                ))}
            </div>
            <ProtocolDiagnostics diagnostics={state.configurationDiagnostics} />
            {state.activity === "save_failed" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    <p>{state.message === undefined ? "" : displayText(state.message)}</p>
                    <button
                        data-oaam-interaction-entry="features.discovery.discovery_setup_choices.004"
                        type="button"
                        onClick={() => void controller.load()}
                    >
                        {text("discovery.ui.refresh_settings")}
                    </button>
                </WorkbenchNotice>
            ) : null}
        </>
    );
}
