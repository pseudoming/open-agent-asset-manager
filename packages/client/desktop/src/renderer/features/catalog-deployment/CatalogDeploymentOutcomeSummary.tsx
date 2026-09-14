import { type DesktopMessageId, type DesktopMessageValues, useDesktopPresentation } from "../../presentation";
import { WorkbenchDisclosure, WorkbenchPanel } from "../../ui";
import type { AdapterProviderView } from "../discovery/presentation";
import { presentDiscoveryAgentRuntime } from "../discovery/presentation";
import { CatalogReverseResult } from "./CatalogReverseReview";
import type { CatalogDeploymentState } from "./catalog-deployment-controller";
import type { AssetSummaryView, DeploymentTargetView, DeploymentView } from "./catalog-deployment-model";
import type { DeploymentReverseState } from "./catalog-deployment-state";
import { deploymentAssetVersionLabels } from "./render-review-presentation";

type ReadyCatalogDeploymentState = Extract<CatalogDeploymentState, { readonly status: "ready" }>;

export interface CatalogDeploymentOutcomeSummaryProps {
    readonly state: ReadyCatalogDeploymentState;
    readonly providers: readonly AdapterProviderView[];
    readonly selectedDeployment: DeploymentView | undefined;
    readonly selectedDeploymentTarget: DeploymentTargetView | undefined;
    readonly selectedCreationAsset: AssetSummaryView | undefined;
    readonly selectedReverse: DeploymentReverseState;
    readonly completedMutationIsCurrent: boolean;
    readonly canRecover: boolean;
    readonly canCheckNow: boolean;
    readonly canInspect: boolean;
}

export function catalogDeploymentMutationIsCurrent(
    state: ReadyCatalogDeploymentState,
    selectedDeployment: DeploymentView | undefined,
): boolean {
    return (
        selectedDeployment !== undefined &&
        state.activity.status === "idle" &&
        !state.stale &&
        !state.requiresReconciliation &&
        !(
            state.message?.kind === "localized" &&
            ["catalog.operation.failed", "catalog.operation.interrupted", "catalog.operation.lost_terminal"].includes(
                state.message.id,
            )
        ) &&
        state.completedMutation?.deploymentId === selectedDeployment.deploymentId &&
        selectedDeployment.stage === "in_sync" &&
        !selectedDeployment.actionHints.includes("review_deployment") &&
        selectedDeployment.freshness.state === "complete"
    );
}

export function catalogDeploymentWorkspaceTitle(
    input: Readonly<{
        initialAssetId: string | undefined;
        selectedCreationAsset: AssetSummaryView | undefined;
        selectedReverse: DeploymentReverseState;
        selectedDeployment: DeploymentView | undefined;
        completedMutationIsCurrent: boolean;
    }>,
    text: (id: DesktopMessageId, values?: DesktopMessageValues) => string,
): string {
    if (input.initialAssetId === undefined) return text("catalog.ui.workspace.manage");
    if (input.selectedCreationAsset === undefined) return text("catalog.ui.workspace.create");
    const values = { asset: input.selectedCreationAsset.displayName };
    if (input.selectedReverse.status === "result") return text("catalog.ui.workspace.reverse_asset", values);
    if (input.completedMutationIsCurrent) return text("catalog.ui.workspace.applied_asset", values);
    return input.selectedDeployment === undefined
        ? text("catalog.ui.workspace.create_asset", values)
        : text("catalog.ui.workspace.review_asset", values);
}

export function CatalogDeploymentOutcomeSummary({
    state,
    providers,
    selectedDeployment,
    selectedDeploymentTarget,
    selectedCreationAsset,
    selectedReverse,
    completedMutationIsCurrent,
    canRecover,
    canCheckNow,
    canInspect,
}: CatalogDeploymentOutcomeSummaryProps): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    const completedMutation =
        selectedDeployment !== undefined && state.completedMutation?.deploymentId === selectedDeployment.deploymentId
            ? state.completedMutation
            : undefined;
    const outcomeKind =
        selectedReverse.status === "result"
            ? `reverse_${selectedReverse.value.commitState}`
            : completedMutationIsCurrent
              ? completedMutation?.kind
              : undefined;
    if (outcomeKind === undefined || selectedDeployment === undefined) return null;
    const outcomeFilePaths =
        selectedReverse.status === "result"
            ? (selectedReverse.reviewedFilePaths ?? [])
            : completedMutationIsCurrent
              ? (completedMutation?.reviewedFilePaths ?? [])
              : [];
    const publishedVersion =
        selectedReverse.status === "result" &&
        (selectedReverse.value.commitState === "committed" ||
            (selectedReverse.value.commitState === "not_committed" &&
                selectedReverse.value.versionPublicationState === "published_not_selected"))
            ? selectedReverse.value.version
            : undefined;
    const outcomeVersions = publishedVersion === undefined ? selectedDeployment.assets : [publishedVersion];
    const publishedAsset =
        publishedVersion === undefined ? undefined : state.assets.find((asset) => asset.assetId === publishedVersion.assetId);
    const assetVersionLabels = deploymentAssetVersionLabels(selectedDeployment, state.assets, text);
    const outcomeAssetName =
        publishedAsset?.displayName ??
        selectedCreationAsset?.displayName ??
        (selectedDeployment.assets.length === 1
            ? state.assets.find((candidate) => candidate.assetId === selectedDeployment.assets[0]?.assetId)?.displayName
            : undefined) ??
        text("catalog.ui.workspace.create");
    const singleAsset =
        selectedDeployment.assets.length === 1
            ? state.assets.find((candidate) => candidate.assetId === selectedDeployment.assets[0]?.assetId)
            : undefined;
    const repeatedSingleAssetFile =
        singleAsset !== undefined &&
        outcomeFilePaths.some((path) => path.replaceAll("\\", "/").split("/").at(-1) === singleAsset.displayName);
    const publishedVersionLabel =
        publishedAsset !== undefined && publishedAsset.currentVersionId === publishedVersion?.versionId
            ? text("catalog.ui.outcome.revision", { revision: publishedAsset.currentRevision })
            : text("catalog.ui.outcome.new_version");
    const outcomeAssets =
        publishedVersion !== undefined
            ? [publishedAsset === undefined ? publishedVersionLabel : `${publishedAsset.displayName} · ${publishedVersionLabel}`]
            : repeatedSingleAssetFile
              ? selectedDeployment.assets.map((selection) =>
                    singleAsset.currentVersionId === selection.versionId
                        ? text("catalog.ui.outcome.revision", { revision: singleAsset.currentRevision })
                        : text("catalog.ui.outcome.selected_version"),
                )
              : assetVersionLabels;
    const outcomeRuntimeLabels = selectedDeployment.consumerAgentRuntimeIds.map((agentRuntimeId) => {
        const presentation = presentDiscoveryAgentRuntime(agentRuntimeId, providers);
        const runtimeName = presentation.known ? displayText(presentation.label) : agentRuntimeId;
        const identity = selectedDeploymentTarget?.runtimeIdentities.find(
            (candidate) => candidate.agentRuntimeId === agentRuntimeId,
        );
        return identity === undefined
            ? runtimeName
            : text("catalog.product.runtime_version", { runtime: runtimeName, version: identity.versionText });
    });
    const outcomeRuntimeVersions = selectedDeployment.consumerAgentRuntimeIds.map(
        (agentRuntimeId) =>
            selectedDeploymentTarget?.runtimeIdentities.find((identity) => identity.agentRuntimeId === agentRuntimeId)
                ?.versionText ?? "",
    );
    const outcomeNextAction = canRecover
        ? text("catalog.ui.action.recover")
        : canCheckNow && !completedMutationIsCurrent
          ? text("catalog.ui.action.scan")
          : canInspect && !completedMutationIsCurrent
            ? text("catalog.ui.action.inspect")
            : undefined;
    return (
        <WorkbenchPanel
            surface="section"
            className="deployment-outcome-summary"
            aria-labelledby="deployment-outcome-title"
            data-oaam-deployment-result={outcomeKind}
            data-oaam-result-deployment-id={selectedDeployment.deploymentId}
            data-oaam-result-target-key={selectedDeploymentTarget?.key}
            data-oaam-result-runtime-ids={JSON.stringify(selectedDeployment.consumerAgentRuntimeIds)}
            data-oaam-result-runtime-versions={JSON.stringify(outcomeRuntimeVersions)}
            data-oaam-result-version-ids={JSON.stringify(outcomeVersions.map((selection) => selection.versionId))}
            data-oaam-result-file-paths={JSON.stringify(outcomeFilePaths)}
            data-oaam-result-files-available={outcomeFilePaths.length > 0}
        >
            <div className="section-heading">
                <div>
                    <p className="eyebrow">
                        {text(
                            selectedReverse.status === "result"
                                ? "catalog.ui.reverse.result_title"
                                : completedMutation?.kind === "recover"
                                  ? "catalog.ui.action.recover"
                                  : "catalog.ui.usage.status.applied",
                        )}
                    </p>
                    <h2 id="deployment-outcome-title">
                        {selectedReverse.status === "result"
                            ? outcomeAssetName
                            : text(
                                  completedMutation?.kind === "recover"
                                      ? "catalog.ui.outcome.recovered_title"
                                      : "catalog.ui.create.applied_title",
                              )}
                    </h2>
                </div>
            </div>
            {selectedReverse.status === "result" ? (
                <CatalogReverseResult reverse={selectedReverse} compact />
            ) : (
                <p>{text("catalog.ui.outcome.selected_version_matches")}</p>
            )}
            <ul className="deployment-outcome-identities">
                {outcomeRuntimeLabels.map((runtime) => (
                    <li key={`runtime:${runtime}`}>{text("catalog.ui.outcome.tool_entry", { entry: runtime })}</li>
                ))}
                {outcomeAssets.map((asset) => (
                    <li key={`asset:${asset}`}>{text("catalog.ui.outcome.asset_version", { version: asset })}</li>
                ))}
            </ul>
            <p className="deployment-outcome-location">
                {text("catalog.ui.outcome.location", { path: selectedDeployment.targetRootPath })}
            </p>
            {outcomeFilePaths.length === 0 ? null : outcomeFilePaths.length === 1 ? (
                <p data-oaam-result-files>{text("catalog.ui.outcome.files", { files: outcomeFilePaths[0] ?? "" })}</p>
            ) : (
                <WorkbenchDisclosure summary={text("catalog.ui.outcome.file_count", { count: outcomeFilePaths.length })}>
                    <ul className="deployment-outcome-files" data-oaam-result-files>
                        {outcomeFilePaths.map((filePath) => (
                            <li key={filePath}>
                                <code>{filePath}</code>
                            </li>
                        ))}
                    </ul>
                </WorkbenchDisclosure>
            )}
            {outcomeNextAction === undefined ||
            (selectedReverse.status === "result" && state.requiresReconciliation && canRecover) ? null : (
                <p data-oaam-result-next-action>{text("catalog.ui.outcome.next_action", { action: outcomeNextAction })}</p>
            )}
        </WorkbenchPanel>
    );
}
