import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import type { ReactNode } from "react";
import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice, WorkbenchPanel } from "../../ui";
import type { DiscoveryController, DiscoveryState } from "./discovery-controller";
import type { DiscoveryEnvironmentProbeOutcome, DiscoveryWatchSelection } from "./discovery-model";

interface DiscoverySettingsLocationsPanelProps {
    readonly busy: boolean;
    readonly controller: DiscoveryController;
    readonly environmentProbeOutcomes: readonly DiscoveryEnvironmentProbeOutcome[];
    readonly hasUnsavedWatchSelections: boolean;
    readonly onReviewSources?: (request: ProtocolOperationParams<"adapter.read">) => void;
    readonly onSaveProviderEnablementAndProbe: () => Promise<void>;
    readonly readRequest: ProtocolOperationParams<"adapter.read"> | undefined;
    readonly results: ReactNode;
    readonly sourceReview: ReactNode;
    readonly state: Extract<DiscoveryState, { readonly status: "ready" }>;
    readonly unsaved: boolean;
    readonly watchSelections: readonly DiscoveryWatchSelection[];
    readonly watchedCount: number;
}

export function DiscoverySettingsLocationsPanel({
    busy,
    controller,
    environmentProbeOutcomes,
    hasUnsavedWatchSelections,
    onReviewSources,
    onSaveProviderEnablementAndProbe,
    readRequest,
    results,
    sourceReview,
    state,
    unsaved,
    watchSelections,
    watchedCount,
}: DiscoverySettingsLocationsPanelProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    return (
        <WorkbenchPanel aria-labelledby="source-title">
            <div className="section-heading">
                <div>
                    <p className="eyebrow">{text("discovery.settings.locations.eyebrow")}</p>
                    <h2 id="source-title">{text("discovery.settings.locations.title")}</h2>
                </div>
                <button
                    data-oaam-interaction-entry="features.discovery.discovery_workspace.011"
                    type="button"
                    data-oaam-discovery-run
                    disabled={busy || state.selectedAdapterIds.length === 0 || state.selectedEnvironmentKeys.length === 0}
                    onClick={() => void onSaveProviderEnablementAndProbe()}
                >
                    {text(
                        state.activity === "probing"
                            ? "discovery.ui.scanning"
                            : unsaved
                              ? "discovery.ui.save_and_run"
                              : "discovery.ui.run",
                    )}
                </button>
            </div>
            <p className="section-copy">
                {text("discovery.settings.locations.copy", {
                    environments: state.environments.length,
                    watched: watchedCount,
                })}
            </p>
            {unsaved ? <WorkbenchNotice>{text("discovery.ui.save_before_scan")}</WorkbenchNotice> : null}
            {results}
            {sourceReview}
            {onReviewSources === undefined ? null : (
                <button
                    data-oaam-interaction-entry="features.discovery.discovery_workspace.012"
                    type="button"
                    disabled={busy || readRequest === undefined}
                    onClick={() => {
                        if (readRequest !== undefined) onReviewSources(readRequest);
                    }}
                >
                    {text("discovery.ui.review_sources")}
                </button>
            )}
            {!hasUnsavedWatchSelections ? null : (
                <button
                    data-oaam-interaction-entry="features.discovery.discovery_workspace.013"
                    type="button"
                    disabled={busy || state.probeReview === undefined}
                    onClick={() => void controller.saveWatchedSources(watchSelections)}
                >
                    {text(
                        state.activity === "saving_watch" ? "discovery.product.follow.saving" : "discovery.product.follow.save",
                    )}
                </button>
            )}
            {state.message !== undefined &&
            state.activity === "idle" &&
            !(
                environmentProbeOutcomes.length > 0 &&
                state.message.kind === "localized" &&
                state.message.id === "discovery.complete_with_warnings"
            ) ? (
                <WorkbenchNotice role="status">{displayText(state.message)}</WorkbenchNotice>
            ) : null}
            {state.activity === "watch_failed" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {state.message === undefined ? "" : displayText(state.message)}
                    <ProtocolDiagnostics diagnostics={state.activityDiagnostics} layout="grouped" />
                </WorkbenchNotice>
            ) : null}
        </WorkbenchPanel>
    );
}
