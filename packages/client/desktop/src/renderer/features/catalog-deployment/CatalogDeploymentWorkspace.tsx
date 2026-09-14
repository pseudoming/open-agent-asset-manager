import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { DesktopIcon, StatusPanel, WorkbenchIconButton, WorkbenchNotice, WorkbenchPanel } from "../../ui";
import { type AdapterProviderView, presentDiscoveryEnvironment } from "../discovery/presentation";
import {
    CatalogDeploymentAnalysisNotice,
    CatalogDeploymentCreateReview,
    catalogCreationApplyLabel,
    catalogCreationMessage,
    catalogCreationRuntimeLabel,
} from "./CatalogAssetUsageRelationships";
import { CatalogDeploymentAssetStep } from "./CatalogDeploymentAssetStep";
import { CatalogDeploymentActions } from "./CatalogDeploymentActions";
import { useDeploymentReviewFocus } from "./use-deployment-review-focus";
import { CatalogDeploymentInspectionReview } from "./CatalogDeploymentInspectionReview";
import { CatalogDeploymentList } from "./CatalogDeploymentList";
import {
    CatalogDeploymentOperationNotices,
    catalogDeploymentReconciliationPresentation,
} from "./CatalogDeploymentOperationNotices";
import {
    CatalogDeploymentOutcomeSummary,
    catalogDeploymentMutationIsCurrent,
    catalogDeploymentWorkspaceTitle,
} from "./CatalogDeploymentOutcomeSummary";
import { CatalogDeploymentPreviewFiles } from "./CatalogDeploymentPreviewFiles";
import { CatalogDeploymentRelationshipStage } from "./CatalogDeploymentRelationshipStage";
import { CatalogDeploymentReplacementDecision } from "./CatalogDeploymentReplacementDecision";
import { CatalogDeploymentVersionUpdate } from "./CatalogDeploymentVersionUpdate";
import {
    CatalogRenderOutputSummary,
    CatalogRenderPassiveSingletonSummary,
    catalogRenderReviewIsPassiveSingleton,
} from "./CatalogRenderReviewDetails";
import { CatalogReverseReview } from "./CatalogReverseReview";
import { CatalogRenderDecisions } from "./CatalogRenderDecisions";
import type { CatalogDeploymentController, CatalogDeploymentState } from "./catalog-deployment-controller";
import {
    type AssetVersionView,
    buildAssetUsageAnalysisRequests,
    buildDeploymentCreateRequest,
    buildRenderSelection,
    collectDeploymentTargets,
    collectDeploymentToolObservations,
    type DeploymentAssetSelection,
    type DeploymentWorkspaceSubject,
    deploymentAssetsForSubject,
    deploymentsForSubject,
    deploymentTargetForDeployment,
    deploymentTargetMatchesSubject,
    includeSingletonRenderSelections,
    type ProbeReviewView,
    projectRenderReview,
    type RenderOptionSelection,
} from "./catalog-deployment-model";
import { reverseDeploymentId } from "./catalog-deployment-reverse-controller";
import { catalogDeploymentFailurePresentationState } from "./catalog-deployment-state";
import { PREVIEW_ACTION_MESSAGES } from "./render-review-presentation";
import { useCatalogAssetUsage } from "./use-catalog-asset-usage";
export interface CatalogDeploymentWorkspaceProps {
    readonly controller: CatalogDeploymentController;
    readonly subject: DeploymentWorkspaceSubject;
    readonly probeReview: ProbeReviewView | undefined;
    readonly providers: readonly AdapterProviderView[];
    readonly assetImportSource?: AssetVersionView["importSource"];
    readonly initialAssetId?: string;
    readonly targetDiscovery?: ReactNode;
    readonly installationLocationBusy?: boolean;
    readonly installationRootFailureKey?: string;
    readonly onChooseInstallationRoot?: (
        adapterId: string,
        environment: ProbeReviewView["results"][number]["environment"],
    ) => void;
    readonly onDeploymentCreated?: (deploymentId: string) => void;
    readonly onRelationshipAnalysisSettled?: () => void;
    readonly onOpenAssetUsage?: (assetId: string) => void;
    readonly onOpenLibrary?: () => void;
}
export function CatalogDeploymentWorkspace({
    controller,
    subject,
    probeReview,
    providers,
    assetImportSource,
    initialAssetId,
    targetDiscovery,
    installationLocationBusy = false,
    installationRootFailureKey = "",
    onChooseInstallationRoot,
    onDeploymentCreated,
    onRelationshipAnalysisSettled,
    onOpenAssetUsage,
    onOpenLibrary,
}: CatalogDeploymentWorkspaceProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const [state, setState] = useState<CatalogDeploymentState>(controller.state);
    const [deploymentAssets, setDeploymentAssets] = useState<readonly DeploymentAssetSelection[]>([]);
    const [selectedDeploymentId, setSelectedDeploymentId] = useState("");
    const [openedUsageId, setOpenedUsageId] = useState<string>();
    const { workspaceRef, requestReviewFocus, requestPreviewFocus } = useDeploymentReviewFocus();
    const [selectedCreationTargetKey, setSelectedCreationTargetKey] = useState("");
    const [renderSelections, setRenderSelections] = useState<readonly RenderOptionSelection[]>([]);
    const completedMutation = state.status === "ready" ? state.completedMutation : undefined;
    const [expandedPreparation, setExpandedPreparation] = useState<
        | Readonly<{
              assetId: string | undefined;
              deploymentId: string;
              mutation: typeof completedMutation;
          }>
        | undefined
    >();
    const preparationExpanded =
        expandedPreparation !== undefined &&
        expandedPreparation.assetId === initialAssetId &&
        expandedPreparation.deploymentId === selectedDeploymentId &&
        expandedPreparation.mutation === completedMutation;
    const targets = useMemo(
        () =>
            collectDeploymentTargets(probeReview).filter((target) =>
                deploymentTargetMatchesSubject(target, subject, state.status === "ready" ? state.projects : []),
            ),
        [probeReview, state, subject],
    );
    const selectedAssetKind =
        state.status === "ready" ? state.assets.find((asset) => asset.assetId === deploymentAssets[0]?.assetId)?.kind : undefined;
    const toolObservations = useMemo(
        () => collectDeploymentToolObservations(probeReview, providers, selectedAssetKind, targets),
        [probeReview, providers, selectedAssetKind, targets],
    );
    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        void controller.load();
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);
    useEffect(() => {
        if (initialAssetId === undefined || state.status !== "ready") return;
        const asset = deploymentAssetsForSubject(state.assets, subject).find((candidate) => candidate.assetId === initialAssetId);
        if (asset === undefined) {
            setDeploymentAssets((current) => (current.length === 0 ? current : []));
            return;
        }
        setDeploymentAssets((current) => {
            const previous = current.find((candidate) => candidate.assetId === asset.assetId);
            const next = {
                assetId: asset.assetId,
                versionId: asset.currentVersionId,
                allowIncomplete: previous?.versionId === asset.currentVersionId ? previous.allowIncomplete : false,
            };
            return current.length === 1 &&
                current[0]?.assetId === next.assetId &&
                current[0].versionId === next.versionId &&
                current[0].allowIncomplete === next.allowIncomplete
                ? current
                : [next];
        });
    }, [initialAssetId, state, subject]);
    const usageRequests = useMemo(
        () => buildAssetUsageAnalysisRequests(subject, targets, deploymentAssets[0]),
        [deploymentAssets, subject, targets],
    );
    const usageRequestKey = useMemo(
        () =>
            usageRequests.length === 0
                ? ""
                : JSON.stringify(
                      usageRequests.map((request) => [
                          request.targetKey,
                          request.params.probeToken,
                          request.params.probeResultRowId,
                          request.params.targetRowId,
                          request.params.consumerAgentRuntimeIds,
                          request.params.asset,
                      ]),
                  ),
        [usageRequests],
    );
    useCatalogAssetUsage({
        controller,
        state,
        initialAssetId,
        requests: usageRequests,
        requestKey: usageRequestKey,
        targets,
        probeToken: probeReview?.probeToken,
        onSettled: onRelationshipAnalysisSettled,
    });
    useEffect(() => {
        if (initialAssetId === undefined || state.status !== "ready") return;
        const visible = deploymentsForSubject(state.deployments, subject);
        setSelectedDeploymentId((current) => {
            if (visible.some((deployment) => deployment.deploymentId === current)) return current;
            const matching = visible.filter((deployment) => deployment.assets.some((asset) => asset.assetId === initialAssetId));
            return matching.length === 1 ? (matching[0]?.deploymentId ?? "") : "";
        });
    }, [initialAssetId, state, subject]);
    if (state.status === "loading") {
        return (
            <StatusPanel
                eyebrow={text("catalog.ui.catalog_eyebrow")}
                title={text("catalog.ui.catalog_loading")}
                message={displayText(state.message)}
                busy
            />
        );
    }
    if (state.status === "failed") {
        return (
            <StatusPanel
                eyebrow={text("catalog.ui.catalog_eyebrow")}
                title={text("catalog.ui.catalog_unavailable")}
                message={displayText(state.message)}
                tone="danger"
            >
                <button
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.001"
                    type="button"
                    onClick={() => void controller.load()}
                >
                    {text("common.retry")}
                </button>
                <ProtocolDiagnostics diagnostics={state.diagnostics} technicalSummary={text("import.ui.technical_details")} />
            </StatusPanel>
        );
    }
    const busy = state.activity.status !== "idle";
    const interactionLocked = busy || state.reverse.status === "prepared" || state.assetUsage.status === "loading";
    const eligibleAssets = deploymentAssetsForSubject(state.assets, subject);
    const projects = state.projects;
    const selectedCreationAsset =
        initialAssetId === undefined ? undefined : eligibleAssets.find((candidate) => candidate.assetId === initialAssetId);
    const visibleDeployments = deploymentsForSubject(state.deployments, subject);
    const selectedDeployment = visibleDeployments.find((deployment) => deployment.deploymentId === selectedDeploymentId);
    const selectedCreationTarget =
        targets.find((target) => target.key === selectedCreationTargetKey) ??
        (selectedDeployment === undefined ? undefined : deploymentTargetForDeployment(targets, selectedDeployment));
    const selectedDeploymentTarget =
        selectedDeployment === undefined ? undefined : deploymentTargetForDeployment(targets, selectedDeployment);
    const selectedTargetLabel =
        selectedDeployment === undefined
            ? ""
            : `${selectedDeployment.consumerAgentRuntimeIds
                  .map((id) => catalogCreationRuntimeLabel(selectedDeploymentTarget, id, providers, { displayText, text }))
                  .join(", ")} · ${displayText(presentDiscoveryEnvironment(selectedDeployment.environment))}`;
    const selectedReverse =
        reverseDeploymentId(state.reverse) === selectedDeploymentId ? state.reverse : { status: "none" as const };
    const selectedAnalysis =
        selectedReverse.status === "none" &&
        state.analysis.status === "ready" &&
        state.analysis.value.deploymentId === selectedDeploymentId
            ? state.analysis.value
            : undefined;
    const selectedInspection =
        state.inspection.status === "ready" && state.inspection.value.deploymentId === selectedDeploymentId
            ? state.inspection
            : undefined;
    const selectedPreview =
        selectedReverse.status === "none" &&
        state.preview.status === "ready" &&
        state.preview.value.deploymentId === selectedDeploymentId
            ? state.preview.value
            : undefined;
    const reconciliationPresentation = catalogDeploymentReconciliationPresentation(state.requiresReconciliation, selectedReverse);
    const reverseOwnsFeedback =
        selectedReverse.status === "failed" ||
        selectedReverse.status === "not_prepared" ||
        (selectedReverse.status === "prepared" && selectedReverse.message !== undefined);
    const detailOwnsFeedback =
        reverseOwnsFeedback ||
        (state.analysis.status === "failed" && state.analysis.deploymentId === selectedDeploymentId) ||
        (state.preview.status === "failed" && state.preview.deploymentId === selectedDeploymentId) ||
        (state.inspection.status === "failed" && state.inspection.deploymentId === selectedDeploymentId);
    const managedDiagnostics = initialAssetId === undefined || detailOwnsFeedback ? state.diagnostics : [];
    const actionHints = selectedDeployment?.actionHints ?? [];
    const canReviewDeployment = actionHints.includes("review_deployment") || actionHints.includes("review_external_changes");
    const canCheckNow = actionHints.includes("check_now");
    const canInspect = actionHints.includes("review_external_changes") || actionHints.includes("review_repair");
    const canRepair = actionHints.includes("review_repair");
    const canReviewConflict = actionHints.includes("review_external_changes");
    // A failed completion or projection refresh retains the exact result-local
    // retry route even when the Deployment itself is already in sync.
    const canRecover =
        actionHints.includes("recover") ||
        (state.requiresReconciliation &&
            (selectedReverse.status === "result" || state.pendingRecoveryDeploymentId === selectedDeploymentId));
    const reviewIsCurrent = !state.stale && !state.requiresReconciliation;
    const primaryAction = canRecover
        ? "recover"
        : canInspect
          ? "inspect"
          : canReviewDeployment && (selectedAnalysis === undefined || !reviewIsCurrent)
            ? "analyze"
            : canCheckNow
              ? "scan"
              : undefined;
    const needsSupport = actionHints.includes("contact_support");
    const deploymentActions = (
        <CatalogDeploymentActions
            controller={controller}
            deployment={selectedDeployment}
            creation={initialAssetId !== undefined && openedUsageId !== selectedDeploymentId}
            analysisFailed={state.analysis.status === "failed"}
            primaryAction={primaryAction}
            canReview={canReviewDeployment && (selectedAnalysis === undefined || !reviewIsCurrent)}
            canCheck={canCheckNow}
            canInspect={canInspect}
            canRecover={canRecover}
            disabled={interactionLocked}
            stale={state.stale}
        />
    );
    const renderReview = selectedAnalysis === undefined ? undefined : projectRenderReview(selectedAnalysis);
    const passiveRenderReview = renderReview?.status === "ready" && catalogRenderReviewIsPassiveSingleton(renderReview);
    const renderHasChoices =
        renderReview?.status === "ready" &&
        renderReview.groups.some(
            (group) => group.options.length > 1 || group.options.some(({ option }) => option.approvalState === "required"),
        );
    const appliedCreation =
        selectedDeployment?.stage === "in_sync" &&
        selectedDeployment.freshness.state === "complete" &&
        !selectedDeployment.actionHints.includes("review_deployment");
    const creationSettledInRelationships =
        initialAssetId !== undefined &&
        openedUsageId !== selectedDeploymentId &&
        selectedCreationAsset !== undefined &&
        selectedDeployment !== undefined &&
        appliedCreation &&
        !interactionLocked &&
        !state.stale &&
        !state.requiresReconciliation &&
        selectedReverse.status === "none" &&
        state.analysis.status === "none" &&
        state.preview.status === "none" &&
        state.inspection.status === "none" &&
        state.assetUsage.status === "ready" &&
        state.assetUsage.requestKey === usageRequestKey &&
        state.assetUsage.targets.some(
            (result) =>
                result.status === "ready" &&
                result.targetKey === selectedDeploymentTarget?.key &&
                result.usage.assetId === selectedCreationAsset.assetId &&
                result.usage.versionId === selectedCreationAsset.currentVersionId &&
                selectedDeployment.consumerAgentRuntimeIds.every((agentRuntimeId) =>
                    result.usage.relationships.some(
                        (relationship) =>
                            relationship.agentRuntimeId === agentRuntimeId &&
                            relationship.deploymentIds.includes(selectedDeployment.deploymentId) &&
                            relationship.managedState === "applied" &&
                            relationship.observedTargetState === "already_usable",
                    ),
                ),
        );
    const effectiveRenderSelections =
        renderReview?.status === "ready" ? includeSingletonRenderSelections(renderReview, renderSelections) : renderSelections;
    const renderSelectionValidation =
        selectedAnalysis === undefined
            ? undefined
            : buildRenderSelection(selectedAnalysis, effectiveRenderSelections, "validation-only");
    const previewAuthorizationBlocked =
        selectedAnalysis?.promotionAuthorizationInspections.some(
            (inspection) =>
                inspection.promotionAuthorizationState === "required" || inspection.promotionAuthorizationState === "unavailable",
        ) ?? false;
    const completedMutationIsCurrent = catalogDeploymentMutationIsCurrent(state, selectedDeployment);
    const preparationCollapsed =
        initialAssetId !== undefined && completedMutationIsCurrent && !canRecover && !preparationExpanded;
    const workspaceTitle = catalogDeploymentWorkspaceTitle(
        { initialAssetId, selectedCreationAsset, selectedReverse, selectedDeployment, completedMutationIsCurrent },
        text,
    );
    function updateRenderOptions(updates: readonly RenderOptionSelection[]): void {
        controller.clearPreview();
        const refs = new Set(updates.map((selection) => selection.semanticRefFingerprint));
        setRenderSelections((current) => [
            ...current.filter((selection) => !refs.has(selection.semanticRefFingerprint)),
            ...updates,
        ]);
    }
    function prepareAssetUsage(targetKey: string, agentRuntimeId: string): void {
        const createRequest = buildDeploymentCreateRequest(
            { subject, targetKey, consumerAgentRuntimeIds: [agentRuntimeId], assets: deploymentAssets },
            targets,
            projects,
            eligibleAssets,
        );
        if (createRequest.status !== "ready") return;
        void controller.createDeployment(createRequest.params).then((deploymentId) => {
            if (deploymentId === undefined) return;
            setSelectedCreationTargetKey(targetKey);
            setSelectedDeploymentId(deploymentId);
            requestReviewFocus();
            onDeploymentCreated?.(deploymentId);
            void controller.analyze(deploymentId);
        });
    }
    return (
        <div
            className="catalog-deployment-workspace"
            ref={workspaceRef}
            aria-busy={busy}
            data-oaam-deployment-mode={initialAssetId === undefined ? "manage" : "create"}
            data-oaam-deployment-workspace-state="ready"
            data-oaam-deployment-count={visibleDeployments.length}
            data-oaam-deployment-activity={
                state.activity.status === "idle" ? "idle" : `${state.activity.kind}:${state.activity.status}`
            }
            data-oaam-deployment-analysis={state.analysis.status}
            data-oaam-deployment-preview={
                selectedPreview === undefined
                    ? selectedReverse.status === "none"
                        ? state.preview.status
                        : "none"
                    : `ready:${selectedPreview.actionState}`
            }
            data-oaam-deployment-inspection={state.inspection.status}
            data-oaam-inspection-change-count={state.inspection.status === "ready" ? state.inspection.value.changeCount : 0}
            data-oaam-inspection-conflict-count={state.inspection.status === "ready" ? state.inspection.value.conflictCount : 0}
            data-oaam-deployment-reverse={
                selectedReverse.status === "result" ? `result:${selectedReverse.value.commitState}` : selectedReverse.status
            }
            data-oaam-deployment-stale={state.stale}
            data-oaam-deployment-diagnostic-count={state.diagnostics.length}
            data-oaam-deployment-reconciliation={reconciliationPresentation}
            data-oaam-deployment-message={
                state.message === undefined ? "none" : state.message.kind === "localized" ? state.message.id : "technical"
            }
            data-oaam-selected-deployment-stage={selectedDeployment?.stage ?? "none"}
            data-oaam-deployment-preparation={preparationCollapsed ? "collapsed" : "open"}
        >
            <header className="workspace-heading deployment-workspace-heading">
                <div>
                    <p className="eyebrow">{text("catalog.ui.workspace.eyebrow")}</p>
                    <h1>{workspaceTitle}</h1>
                </div>
                <WorkbenchIconButton
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.002"
                    className="library-icon-button"
                    icon="refresh"
                    label={text(initialAssetId === undefined ? "catalog.ui.outcome.reload_saved" : "catalog.ui.asset.refresh")}
                    data-oaam-deployment-action="refresh"
                    disabled={interactionLocked}
                    onClick={() => void controller.load()}
                />
            </header>
            <CatalogDeploymentOutcomeSummary
                state={state}
                providers={providers}
                selectedDeployment={selectedDeployment}
                selectedDeploymentTarget={selectedDeploymentTarget}
                selectedCreationAsset={selectedCreationAsset}
                selectedReverse={selectedReverse}
                completedMutationIsCurrent={completedMutationIsCurrent}
                canRecover={canRecover}
                canCheckNow={canCheckNow}
                canInspect={canInspect}
            />
            {state.stale && !(selectedReverse.status === "result" && state.requiresReconciliation) ? (
                <WorkbenchNotice tone="warning" role="alert">
                    {text("catalog.authority_changed")}
                </WorkbenchNotice>
            ) : null}
            {preparationCollapsed ? (
                <div className="detail-actions deployment-outcome-actions">
                    <button
                        type="button"
                        data-oaam-deployment-action="use-another-tool"
                        onClick={() =>
                            setExpandedPreparation({
                                assetId: initialAssetId,
                                deploymentId: selectedDeploymentId,
                                mutation: completedMutation,
                            })
                        }
                    >
                        {text("catalog.ui.outcome.another_tool")}
                    </button>
                    {canCheckNow && selectedDeployment !== undefined ? (
                        <button
                            type="button"
                            className="library-secondary-button"
                            data-oaam-deployment-action="scan"
                            disabled={interactionLocked || state.stale}
                            onClick={() => {
                                setOpenedUsageId(selectedDeployment.deploymentId);
                                requestReviewFocus();
                                void controller.scan(selectedDeployment.deploymentId);
                            }}
                        >
                            {text("catalog.ui.action.scan")}
                        </button>
                    ) : null}
                </div>
            ) : null}
            {initialAssetId === undefined ? null : selectedCreationAsset === undefined ? (
                <StatusPanel
                    eyebrow={text("catalog.ui.create.asset_step_eyebrow")}
                    title={text("catalog.ui.create.asset_unavailable")}
                    message={text("catalog.ui.create.asset_unavailable_copy")}
                    tone="danger"
                />
            ) : (
                <div className="deployment-preparation" hidden={preparationCollapsed}>
                    <CatalogDeploymentAssetStep
                        asset={selectedCreationAsset}
                        allowIncomplete={deploymentAssets[0]?.allowIncomplete ?? false}
                        disabled={interactionLocked}
                        importSource={assetImportSource}
                        providers={providers}
                        onAllowIncompleteChange={(allowIncomplete) => {
                            setDeploymentAssets((current) => current.map((candidate) => ({ ...candidate, allowIncomplete })));
                        }}
                        onPreview={() => void controller.selectAsset(selectedCreationAsset.assetId)}
                    />
                    <CatalogDeploymentRelationshipStage
                        targetDiscovery={targetDiscovery}
                        probeReview={probeReview}
                        subjectKind={subject.subjectKind}
                        observations={toolObservations}
                        deployments={visibleDeployments}
                        assetId={selectedCreationAsset.assetId}
                        usage={state.assetUsage}
                        providers={providers}
                        interactionLocked={interactionLocked || state.stale}
                        installationLocationBusy={installationLocationBusy}
                        installationRootFailureKey={installationRootFailureKey}
                        onChooseInstallationRoot={onChooseInstallationRoot}
                        onPrepare={(target, agentRuntimeId) => prepareAssetUsage(target.key, agentRuntimeId)}
                        onOpenUsage={(target, deploymentId) => {
                            setOpenedUsageId(deploymentId);
                            setSelectedCreationTargetKey(target.key);
                            setSelectedDeploymentId(deploymentId);
                            requestReviewFocus();
                            onDeploymentCreated?.(deploymentId);
                            const deployment = visibleDeployments.find((candidate) => candidate.deploymentId === deploymentId);
                            if (
                                deployment?.actionHints.includes("review_deployment") === true ||
                                deployment?.actionHints.includes("review_external_changes") === true
                            ) {
                                void controller.analyze(deploymentId);
                            }
                        }}
                    />
                </div>
            )}
            <CatalogDeploymentVersionUpdate
                controller={controller}
                state={state}
                deployment={selectedDeployment}
                assetId={initialAssetId}
                assetSelection={deploymentAssets.find((asset) => asset.assetId === initialAssetId)}
                disabled={interactionLocked}
            />
            {initialAssetId === undefined ||
            (selectedDeployment !== undefined && !creationSettledInRelationships && !preparationCollapsed) ? (
                <WorkbenchPanel
                    surface={initialAssetId === undefined ? "bounded" : "section"}
                    aria-labelledby="deployment-title"
                    className={initialAssetId === undefined ? undefined : "deployment-journey-step deployment-create-review"}
                    data-oaam-deployment-step={initialAssetId === undefined ? undefined : "review"}
                >
                    {initialAssetId === undefined ? (
                        <>
                            <div className="section-heading">
                                <div>
                                    <p className="eyebrow">{text("catalog.ui.deployment.eyebrow")}</p>
                                    <h2 id="deployment-title">{text("catalog.ui.deployment.title")}</h2>
                                </div>
                            </div>
                            <CatalogDeploymentList
                                selectedActions={previewAuthorizationBlocked ? undefined : deploymentActions}
                                deployments={visibleDeployments}
                                targets={targets}
                                providers={providers}
                                assets={state.assets}
                                projects={state.projects}
                                selectedDeploymentId={selectedDeploymentId}
                                previousObservationDeploymentId={
                                    state.requiresReconciliation && selectedReverse.status === "result"
                                        ? selectedDeploymentId
                                        : undefined
                                }
                                disabled={interactionLocked}
                                onSelect={(deploymentId) => {
                                    setSelectedDeploymentId(deploymentId);
                                    setRenderSelections([]);
                                    controller.clearPreview();
                                }}
                            />
                        </>
                    ) : selectedDeployment === undefined ? null : (
                        <>
                            <div className="section-heading">
                                <div>
                                    <h2 id="deployment-title">
                                        {text(
                                            appliedCreation
                                                ? "catalog.ui.create.review_eyebrow"
                                                : "catalog.ui.create.review_title",
                                        )}
                                    </h2>
                                </div>
                            </div>
                            {appliedCreation ? null : <p className="section-copy">{text("catalog.ui.create.review_copy")}</p>}
                        </>
                    )}
                    {selectedDeployment !== undefined && (initialAssetId !== undefined || previewAuthorizationBlocked) ? (
                        <CatalogDeploymentCreateReview
                            actions={deploymentActions}
                            controller={controller}
                            subject={subject}
                            asset={
                                selectedCreationAsset ??
                                (selectedDeployment.assets.length === 1
                                    ? eligibleAssets.find((asset) => asset.assetId === selectedDeployment.assets[0]?.assetId)
                                    : undefined)
                            }
                            deployment={selectedDeployment}
                            target={selectedCreationTarget}
                            providers={providers}
                            analysis={selectedAnalysis}
                            targetObservationComplete={probeReview !== undefined}
                            disabled={interactionLocked || state.stale}
                            onOpenAssetUsage={initialAssetId === undefined ? onOpenAssetUsage : undefined}
                            onOpenLibrary={onOpenLibrary}
                        />
                    ) : null}
                    {selectedDeployment === undefined ? deploymentActions : null}
                    <CatalogDeploymentOperationNotices
                        activity={state.activity}
                        creation={initialAssetId !== undefined}
                        message={reverseOwnsFeedback ? undefined : state.message}
                        diagnostics={detailOwnsFeedback ? [] : managedDiagnostics}
                        needsSupport={needsSupport}
                        requiresReconciliation={state.requiresReconciliation}
                        canRecover={canRecover}
                        reverse={selectedReverse}
                        preparedPlanConsumerAgentRuntimeIds={
                            selectedPreview?.actionState === "ready_apply"
                                ? selectedDeployment?.consumerAgentRuntimeIds
                                : undefined
                        }
                    />
                    <CatalogDeploymentAnalysisNotice
                        analysis={state.analysis}
                        deploymentId={selectedDeploymentId}
                        creation={initialAssetId !== undefined}
                        activityVisible={state.activity.status !== "idle"}
                        diagnostics={managedDiagnostics}
                    />
                    {selectedAnalysis === undefined ? null : (
                        <div className="render-analysis">
                            {renderHasChoices ? (
                                <h3>
                                    {text(
                                        catalogCreationMessage(
                                            initialAssetId,
                                            "catalog.ui.render.title",
                                            "catalog.ui.create.review_title",
                                        ),
                                    )}
                                </h3>
                            ) : null}
                            {renderReview?.status === "invalid" ? (
                                <WorkbenchNotice tone="danger" role="alert">
                                    {displayText(renderReview.message)}
                                </WorkbenchNotice>
                            ) : null}
                            {renderReview?.status === "ready" ? (
                                <CatalogRenderOutputSummary review={renderReview} selections={effectiveRenderSelections} />
                            ) : null}
                            {renderReview?.status === "ready" && passiveRenderReview ? (
                                <CatalogRenderPassiveSingletonSummary
                                    review={renderReview}
                                    target={selectedCreationTarget}
                                    providers={providers}
                                />
                            ) : renderReview?.status === "ready" ? (
                                <CatalogRenderDecisions
                                    review={renderReview}
                                    assets={state.assets}
                                    selections={effectiveRenderSelections}
                                    target={selectedCreationTarget}
                                    providers={providers}
                                    disabled={interactionLocked}
                                    onChange={updateRenderOptions}
                                />
                            ) : null}
                            {renderSelectionValidation?.status === "invalid" ? (
                                <WorkbenchNotice>{displayText(renderSelectionValidation.message)}</WorkbenchNotice>
                            ) : null}
                            {renderSelectionValidation?.status === "ready" && !previewAuthorizationBlocked ? (
                                <div className="render-preview-action">
                                    {selectedPreview === undefined ? (
                                        <p>
                                            {text(
                                                !renderHasChoices
                                                    ? "catalog.product.review.passive_preview"
                                                    : catalogCreationMessage(
                                                          initialAssetId,
                                                          "catalog.ui.render.preview_required",
                                                          "catalog.product.review.preview_required",
                                                      ),
                                            )}
                                        </p>
                                    ) : null}
                                    <button
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.013"
                                        type="button"
                                        data-oaam-deployment-action="preview"
                                        className={
                                            primaryAction !== undefined || (selectedPreview !== undefined && reviewIsCurrent)
                                                ? "library-secondary-button"
                                                : undefined
                                        }
                                        disabled={interactionLocked || state.stale}
                                        onClick={() => {
                                            const deploymentId = selectedAnalysis.deploymentId;
                                            void controller
                                                .preview(deploymentId, effectiveRenderSelections)
                                                .then(() => requestPreviewFocus(deploymentId));
                                        }}
                                    >
                                        {text("catalog.ui.action.preview")}
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    )}
                    {state.preview.status === "loading" &&
                    state.preview.deploymentId === selectedDeploymentId &&
                    state.activity.status === "idle" ? (
                        <WorkbenchNotice surface="inline" role="status">
                            {text("catalog.ui.preview.preparing")}
                        </WorkbenchNotice>
                    ) : null}
                    {state.preview.status === "failed" && state.preview.deploymentId === selectedDeploymentId ? (
                        <WorkbenchNotice
                            tone="danger"
                            role="alert"
                            data-oaam-operation-state={catalogDeploymentFailurePresentationState(state.preview.failureKind)}
                            data-oaam-preview-result={state.preview.deploymentId}
                        >
                            <p>{displayText(state.preview.message)}</p>
                            <ProtocolDiagnostics embedded diagnostics={managedDiagnostics} />
                        </WorkbenchNotice>
                    ) : null}
                    {selectedPreview === undefined || selectedDeployment === undefined ? null : (
                        <div className="inspection-summary" data-oaam-preview-result={selectedPreview.deploymentId}>
                            <h3>{text("catalog.ui.preview.title")}</h3>
                            {selectedPreview.replacementScope.directoryPaths.length > 0 ? (
                                <p>
                                    {text("catalog.product.replace.directory_scope")}{" "}
                                    {selectedPreview.replacementScope.directoryPaths.join(", ")}
                                </p>
                            ) : selectedPreview.replacementScope.filePaths.length > 0 ? (
                                <p>{text("catalog.product.replace.file_scope")}</p>
                            ) : null}
                            <CatalogDeploymentPreviewFiles
                                key={selectedPreview.previewToken}
                                files={selectedPreview.files}
                                directories={selectedPreview.directories}
                                suspended={state.assetDetail.status !== "none"}
                                onOpenReview={() => controller.clearAssetSelection()}
                            />
                            <div className="catalog-preview-decision" data-oaam-preview-decision={selectedPreview.actionState}>
                                {selectedPreview.actionState === "ready_apply" ? null : (
                                    <p>{text(PREVIEW_ACTION_MESSAGES[selectedPreview.actionState])}</p>
                                )}
                                {selectedPreview.actionState === "ready_apply" ? (
                                    <div className="catalog-preview-decision-actions">
                                        <button
                                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.016"
                                            type="button"
                                            data-oaam-deployment-action="deploy"
                                            disabled={interactionLocked || state.stale}
                                            onClick={() => void controller.deployPreview("apply")}
                                        >
                                            {initialAssetId === undefined || selectedCreationTarget === undefined
                                                ? text("catalog.ui.action.apply")
                                                : catalogCreationApplyLabel(selectedCreationTarget, providers, {
                                                      displayText,
                                                      text,
                                                  })}
                                        </button>
                                    </div>
                                ) : null}
                                {selectedPreview.actionState === "requires_unmanaged_replacement" ? (
                                    <CatalogDeploymentReplacementDecision
                                        key={selectedPreview.previewToken}
                                        preview={selectedPreview}
                                        targetLabel={selectedTargetLabel}
                                        targetPath={selectedDeployment.targetRootPath}
                                        disabled={interactionLocked || state.stale || state.requiresReconciliation}
                                        onConfirm={() => void controller.deployPreview("replace_unmanaged")}
                                    />
                                ) : null}
                                {selectedPreview.actionState === "blocked_managed_conflict" ? (
                                    <CatalogDeploymentReplacementDecision
                                        key={selectedPreview.previewToken}
                                        preview={selectedPreview}
                                        targetLabel={selectedTargetLabel}
                                        targetPath={selectedDeployment.targetRootPath}
                                        disabled={interactionLocked || state.stale || state.requiresReconciliation}
                                        onConfirm={() => void controller.overwritePreview()}
                                    />
                                ) : null}
                            </div>
                        </div>
                    )}
                    {state.inspection.status === "loading" &&
                    state.inspection.deploymentId === selectedDeploymentId &&
                    state.activity.status === "idle" ? (
                        <WorkbenchNotice surface="inline" role="status">
                            {text("catalog.ui.inspection.inspecting")}
                        </WorkbenchNotice>
                    ) : null}
                    {state.inspection.status === "failed" && state.inspection.deploymentId === selectedDeploymentId ? (
                        <WorkbenchNotice
                            tone="danger"
                            role="alert"
                            data-oaam-operation-state={catalogDeploymentFailurePresentationState(state.inspection.failureKind)}
                        >
                            <p>{displayText(state.inspection.message)}</p>
                            <ProtocolDiagnostics embedded diagnostics={managedDiagnostics} />
                        </WorkbenchNotice>
                    ) : null}
                    {selectedInspection === undefined ? null : (
                        <CatalogDeploymentInspectionReview
                            controller={controller}
                            inspection={selectedInspection}
                            interactionLocked={interactionLocked}
                            stale={state.stale}
                            canRepair={canRepair}
                            canReviewConflict={canReviewConflict}
                        />
                    )}
                    <CatalogReverseReview
                        assets={state.assets}
                        controller={controller}
                        reverse={selectedReverse}
                        busy={busy}
                        stale={state.stale}
                        providers={providers}
                        resultSummaryVisible={selectedDeployment !== undefined}
                        activityVisible={state.activity.status !== "idle"}
                        diagnostics={reverseOwnsFeedback ? managedDiagnostics : []}
                    />
                </WorkbenchPanel>
            ) : null}
        </div>
    );
}
