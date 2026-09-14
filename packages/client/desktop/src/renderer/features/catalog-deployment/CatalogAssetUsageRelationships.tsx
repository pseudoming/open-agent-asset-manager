import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { Fragment, type ReactNode, useState } from "react";
import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import {
    type DesktopDisplayText,
    type DesktopMessageId,
    type DesktopMessageValues,
    localizedText,
    ProtocolDiagnostics,
    uniqueProtocolDiagnostics,
    useDesktopPresentation,
} from "../../presentation";
import { DesktopIcon, WorkbenchNotice, WorkbenchPanel } from "../../ui";
import {
    type AdapterProviderView,
    presentDiscoveryAgentRuntime,
    presentDiscoveryEnvironment,
    presentDiscoveryTool,
} from "../discovery/presentation";
import { ASSET_KIND_MESSAGE_IDS } from "../project-library/model";
import { CatalogDeploymentAuthorizationFallback } from "./CatalogDeploymentAuthorizationFallback";
import { CatalogActivityTechnicalDetails, CatalogTargetTechnicalDetails } from "./CatalogDeploymentTechnicalDetails";
import type { CatalogDeploymentController } from "./catalog-deployment-controller";
import {
    type AssetSummaryView,
    type CurrentProjectPromotionAuthorization,
    currentProjectPromotionAuthorization,
    type DeploymentTargetView,
    type DeploymentToolObservationView,
    type DeploymentView,
    type DeploymentWorkspaceSubject,
    deploymentTargetRuntimeIdentity,
    deploymentTargetForDeployment,
    type RenderAnalysisView,
} from "./catalog-deployment-model";
import {
    type AssetUsageAnalysisState,
    type CatalogDeploymentActivity,
    catalogDeploymentFailurePresentationState,
    type DeploymentAnalysisState,
} from "./catalog-deployment-state";

export interface CatalogAssetUsageRelationshipsProps {
    readonly deployments?: readonly DeploymentView[];
    readonly assetId?: string;
    readonly observations: readonly DeploymentToolObservationView[];
    readonly usage: AssetUsageAnalysisState;
    readonly providers: readonly AdapterProviderView[];
    readonly interactionLocked: boolean;
    readonly installationLocationBusy?: boolean;
    readonly installationRootFailureKey?: string;
    readonly onChooseInstallationRoot?: (
        adapterId: string,
        environment: Pick<DeploymentToolObservationView, "platform" | "platformInstanceId">,
    ) => void;
    readonly onPrepare: (target: DeploymentTargetView, agentRuntimeId: string) => void;
    readonly onOpenUsage: (target: DeploymentTargetView, deploymentId: string) => void;
}

type RelationshipViewMode = "adapter" | "project";

export function CatalogAssetUsageRelationships({
    deployments = [],
    assetId,
    observations,
    usage,
    providers,
    interactionLocked,
    installationLocationBusy = false,
    installationRootFailureKey = "",
    onChooseInstallationRoot,
    onPrepare,
    onOpenUsage,
}: CatalogAssetUsageRelationshipsProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const [viewMode, setViewMode] = useState<RelationshipViewMode>("adapter");
    const [groupVisibility, setGroupVisibility] = useState<ReadonlyMap<string, boolean>>(() => new Map());
    const toggleCompactGroup = (key: string, defaultOpen = false): void => {
        setGroupVisibility((current) => {
            const next = new Map(current);
            next.set(key, !(current.get(key) ?? defaultOpen));
            return next;
        });
    };
    const runtimeLabelForObservation = (observation: DeploymentToolObservationView): string => {
        const label = displayText(presentDiscoveryAgentRuntime(observation.agentRuntimeId, providers).label);
        return observation.versionText.trim() === ""
            ? label
            : text("catalog.product.runtime_version", { runtime: label, version: observation.versionText });
    };
    const toolLabel = (adapterId: string): string => displayText(presentDiscoveryTool(adapterId, providers).label);
    const completedTargets = usage.status === "ready" || usage.status === "loading" ? usage.targets : [];
    const rows = observations.map((observation) => {
        const target = observation.target;
        const result =
            target === undefined ? undefined : completedTargets.find((candidate) => candidate.targetKey === target.key);
        const relationship =
            result?.status === "ready"
                ? result.usage.relationships.find((candidate) => candidate.agentRuntimeId === observation.agentRuntimeId)
                : undefined;
        const analysisDiagnostics = !target?.readyAgentRuntimeIds.includes(observation.agentRuntimeId)
            ? []
            : result?.status === "failed"
              ? (result.diagnostics ?? [])
              : (relationship?.diagnostics ?? []);
        return {
            observation,
            target,
            analysisDiagnostics,
            savedDeployment:
                target === undefined || assetId === undefined
                    ? undefined
                    : deployments.find(
                          (deployment) =>
                              deployment.assets.some((asset) => asset.assetId === assetId) &&
                              deployment.consumerAgentRuntimeIds.includes(observation.agentRuntimeId) &&
                              deploymentTargetForDeployment([target], deployment)?.key === target.key,
                      ),
            agentRuntimeId: observation.agentRuntimeId,
            relationship,
            analysisFailureKind:
                result?.status === "failed" && target?.readyAgentRuntimeIds.includes(observation.agentRuntimeId)
                    ? result.failureKind
                    : result?.status === "ready" &&
                        target?.readyAgentRuntimeIds.includes(observation.agentRuntimeId) &&
                        !result.usage.relationships.some((candidate) => candidate.agentRuntimeId === observation.agentRuntimeId)
                      ? ("verification_failed" as const)
                      : undefined,
            analysisPending:
                (usage.status === "loading" || usage.status === "none") && observation.state === "ready" && result === undefined,
        };
    });
    const groupedRows = new Map<
        string,
        {
            readonly key: string;
            readonly title: string;
            readonly subtitle: string;
            readonly rows: typeof rows;
        }
    >();
    for (const row of rows) {
        const key =
            viewMode === "adapter"
                ? row.observation.adapterId
                : JSON.stringify([
                      row.observation.platform,
                      row.observation.platformInstanceId,
                      row.target?.displayPath ?? row.observation.agentRuntimeId,
                  ]);
        const existing = groupedRows.get(key);
        if (existing !== undefined) {
            existing.rows.push(row);
            continue;
        }
        groupedRows.set(key, {
            key,
            title:
                viewMode === "adapter"
                    ? toolLabel(row.observation.adapterId)
                    : (row.target?.displayName ?? runtimeLabelForObservation(row.observation)),
            subtitle:
                viewMode === "adapter"
                    ? displayText(presentDiscoveryEnvironment(row.observation))
                    : row.target === undefined
                      ? displayText(presentDiscoveryEnvironment(row.observation))
                      : `${displayText(presentDiscoveryEnvironment(row.observation))} · ${row.target.displayPath}`,
            rows: [row],
        });
    }
    const groups = [...groupedRows.values()].map((group) => ({
        ...group,
        subtitle:
            viewMode === "adapter"
                ? [
                      ...new Map(
                          group.rows.map((row) => [
                              desktopEnvironmentKey(row.observation),
                              displayText(presentDiscoveryEnvironment(row.observation)),
                          ]),
                      ).values(),
                  ].join(" · ")
                : group.subtitle,
    }));
    const analysisPending =
        usage.status === "loading" || (usage.status === "none" && rows.some((row) => row.observation.state === "ready"));
    const installationActionOwners = new Map<string, string>();
    for (const row of rows) {
        if (row.observation.state !== "not_installed") continue;
        const key = `${desktopEnvironmentKey(row.observation)}\0${row.observation.adapterId}`;
        if (!installationActionOwners.has(key)) installationActionOwners.set(key, row.observation.key);
    }

    return (
        <WorkbenchPanel
            surface="section"
            className="deployment-journey-step asset-usage-relationships"
            aria-labelledby="asset-usage-relationships-title"
            data-oaam-deployment-step="relationships"
            data-oaam-asset-usage-state={usage.status}
            data-oaam-asset-usage-view={viewMode}
        >
            <div className="section-heading asset-usage-heading">
                <div>
                    <p className="eyebrow">{text("catalog.ui.usage.eyebrow")}</p>
                    <h2 id="asset-usage-relationships-title">{text("catalog.ui.usage.title")}</h2>
                </div>
                <fieldset className="asset-usage-view-switch" aria-label={text("catalog.ui.usage.view_label")}>
                    {(["adapter", "project"] as const).map((mode) => (
                        <button
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.024"
                            data-oaam-asset-usage-view-choice={mode}
                            key={mode}
                            type="button"
                            aria-pressed={viewMode === mode}
                            disabled={viewMode === mode}
                            onClick={() => setViewMode(mode)}
                        >
                            {text(mode === "adapter" ? "catalog.ui.usage.view_adapter" : "catalog.ui.usage.view_project")}
                        </button>
                    ))}
                </fieldset>
            </div>
            <p className="section-copy">{text("catalog.ui.usage.copy")}</p>
            {analysisPending ? (
                <WorkbenchNotice surface="inline" className="asset-usage-loading" role="status" aria-busy="true">
                    <span className="status-card-spinner" data-oaam-loading-indicator>
                        <DesktopIcon name="loading" size={17} />
                    </span>
                    <span>
                        {usage.status === "loading"
                            ? text("catalog.ui.usage.loading_progress", {
                                  completed: usage.completedCount,
                                  total: usage.totalCount,
                              })
                            : text("catalog.ui.usage.loading")}
                    </span>
                </WorkbenchNotice>
            ) : usage.status === "failed" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {displayText(usage.message)}
                </WorkbenchNotice>
            ) : null}
            {rows.length === 0 && !analysisPending && usage.status !== "failed" ? (
                <WorkbenchNotice surface="inline" tone="empty">
                    {text("catalog.ui.usage.empty")}
                </WorkbenchNotice>
            ) : (
                <div className="asset-usage-groups">
                    {groups.map((group) => {
                        const rowIsAvailable = (row: (typeof group.rows)[number]): boolean =>
                            row.observation.state === "ready" &&
                            row.relationship !== undefined &&
                            row.analysisFailureKind === undefined &&
                            row.relationship?.capability !== "unavailable" &&
                            row.relationship?.observedTargetState !== "unknown";
                        const available = group.rows.filter(rowIsAvailable).length;
                        const rowIsPassive = (row: (typeof group.rows)[number]): boolean =>
                            rowIsAvailable(row) &&
                            row.relationship?.observedTargetState === "already_usable" &&
                            row.relationship.managedState !== "configured" &&
                            (row.savedDeployment === undefined ||
                                row.relationship.deploymentIds.includes(row.savedDeployment.deploymentId)) &&
                            row.observation.diagnostics.length === 0;
                        const passiveCount = group.rows.filter(rowIsPassive).length;
                        const rowPriority = (row: (typeof group.rows)[number]): number =>
                            !rowIsAvailable(row) ? 2 : rowIsPassive(row) ? 1 : 0;
                        const orderedRows = [...group.rows].sort((left, right) => {
                            const readiness = rowPriority(left) - rowPriority(right);
                            return readiness === 0
                                ? runtimeLabelForObservation(left.observation).localeCompare(
                                      runtimeLabelForObservation(right.observation),
                                  )
                                : readiness;
                        });
                        const checking = group.rows.filter((row) => row.analysisPending).length;
                        const presentationStates = new Set(
                            group.rows.map((row) =>
                                JSON.stringify([
                                    row.observation.state,
                                    row.analysisPending,
                                    row.analysisFailureKind ?? null,
                                    row.relationship?.capability ?? null,
                                    row.relationship?.observedTargetState ?? null,
                                    row.relationship?.managedState ?? null,
                                ]),
                            ),
                        );
                        const collapsedSummary =
                            checking === 0 &&
                            passiveCount === group.rows.length &&
                            presentationStates.size === 1 &&
                            group.rows.every((row) => row.observation.diagnostics.length === 0);
                        const expansionKey = `${viewMode}\0${group.key}`;
                        const groupOpen = groupVisibility.get(expansionKey) ?? !collapsedSummary;
                        const passiveExpansionKey = `${expansionKey}\0passive`;
                        const passiveExpanded = groupVisibility.get(passiveExpansionKey) ?? false;
                        const compactPassiveRows = passiveCount > 0 && passiveCount < group.rows.length;
                        const secondaryExpansionKey = `${expansionKey}\0secondary`;
                        const secondaryExpanded = groupVisibility.get(secondaryExpansionKey) ?? false;
                        const secondaryCount = available > 0 ? group.rows.length - available : 0;
                        const summaryContent = (
                            <>
                                <span className="asset-usage-group-copy">
                                    <strong>{group.title}</strong>
                                    <small>{group.subtitle}</small>
                                </span>
                                <span className="asset-usage-group-count">
                                    {checking > 0
                                        ? text("catalog.ui.usage.group_checking", {
                                              checking,
                                              total: group.rows.length,
                                          })
                                        : text("catalog.ui.usage.group_available", {
                                              available,
                                              total: group.rows.length,
                                          })}
                                    <DesktopIcon name={groupOpen ? "chevron_down" : "chevron_right"} size={16} />
                                </span>
                            </>
                        );
                        return (
                            <section
                                className="asset-usage-group"
                                data-oaam-adapter-id={viewMode === "adapter" ? group.key : undefined}
                                data-oaam-group-collapsed-summary={collapsedSummary}
                                data-oaam-group-open={groupOpen}
                                key={`${viewMode}:${group.key}`}
                            >
                                <button
                                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.025"
                                    type="button"
                                    className="asset-usage-group-summary"
                                    aria-expanded={groupOpen}
                                    onClick={() => toggleCompactGroup(expansionKey, !collapsedSummary)}
                                >
                                    {summaryContent}
                                </button>
                                {groupOpen ? (
                                    <ul className="asset-usage-list">
                                        {orderedRows.map((row, rowIndex) => {
                                            const {
                                                target,
                                                observation,
                                                agentRuntimeId,
                                                relationship,
                                                analysisFailureKind,
                                                analysisPending: rowPending,
                                            } = row;
                                            const secondaryObservation = available > 0 && !rowIsAvailable(row);
                                            const passiveObservation = compactPassiveRows && rowIsPassive(row);
                                            const capability = relationship?.capability ?? "unavailable";
                                            const observedTargetState = relationship?.observedTargetState ?? "unknown";
                                            const deploymentId =
                                                relationship?.deploymentIds[0] ?? row.savedDeployment?.deploymentId;
                                            const savedVersionOnly =
                                                relationship?.deploymentIds[0] === undefined && row.savedDeployment !== undefined;
                                            const substituteKind = relationship?.substitute?.assetKind;
                                            const installationKey = `${desktopEnvironmentKey(observation)}\0${observation.adapterId}`;
                                            const ownsInstallationAction =
                                                observation.state === "not_installed" &&
                                                installationActionOwners.get(installationKey) === observation.key;
                                            const substituteLabel =
                                                substituteKind === undefined ? "" : text(ASSET_KIND_MESSAGE_IDS[substituteKind]);
                                            const statusLabel =
                                                observation.state !== "ready"
                                                    ? text(`catalog.ui.usage.status.${observation.state}`)
                                                    : rowPending
                                                      ? text("catalog.ui.usage.status.checking")
                                                      : analysisFailureKind !== undefined
                                                        ? text("catalog.ui.usage.status.analysis_failed")
                                                        : relationship?.managedState === "applied"
                                                          ? text(
                                                                observedTargetState === "already_usable"
                                                                    ? "catalog.ui.usage.status.applied"
                                                                    : observedTargetState === "different"
                                                                      ? "catalog.ui.usage.status.managed_different"
                                                                      : observedTargetState === "absent"
                                                                        ? "catalog.ui.usage.status.managed_absent"
                                                                        : "catalog.ui.usage.status.managed_unknown",
                                                            )
                                                          : relationship?.managedState === "configured"
                                                            ? text("catalog.ui.usage.status.configured")
                                                            : capability === "unavailable"
                                                              ? text("catalog.ui.usage.status.unavailable")
                                                              : text(`catalog.ui.usage.status.${observedTargetState}`);
                                            const detail =
                                                observation.state !== "ready"
                                                    ? localizedText(`catalog.ui.usage.detail.${observation.state}`)
                                                    : rowPending
                                                      ? localizedText("catalog.ui.usage.detail.checking")
                                                      : analysisFailureKind !== undefined
                                                        ? localizedText(`catalog.ui.usage.detail.${analysisFailureKind}`)
                                                        : relationship?.managedState === "applied"
                                                          ? localizedText(
                                                                observedTargetState === "already_usable"
                                                                    ? "catalog.ui.usage.detail.applied"
                                                                    : observedTargetState === "different"
                                                                      ? "catalog.ui.usage.detail.managed_different"
                                                                      : observedTargetState === "absent"
                                                                        ? "catalog.ui.usage.detail.managed_absent"
                                                                        : "catalog.ui.usage.detail.managed_unknown",
                                                            )
                                                          : relationship?.managedState === "configured"
                                                            ? localizedText("catalog.ui.usage.detail.configured")
                                                            : capability === "unavailable"
                                                              ? localizedText("catalog.ui.usage.detail.unavailable")
                                                              : observedTargetState === "already_usable"
                                                                ? localizedText("catalog.ui.usage.detail.already_usable")
                                                                : observedTargetState === "unknown"
                                                                  ? localizedText("catalog.ui.usage.detail.unknown")
                                                                  : capability === "direct"
                                                                    ? localizedText(
                                                                          observedTargetState === "absent"
                                                                              ? "catalog.ui.usage.detail.direct_absent"
                                                                              : "catalog.ui.usage.detail.direct_different",
                                                                      )
                                                                    : capability === "transformed"
                                                                      ? localizedText(
                                                                            observedTargetState === "absent"
                                                                                ? "catalog.ui.usage.detail.transformed_absent"
                                                                                : "catalog.ui.usage.detail.transformed_different",
                                                                        )
                                                                      : localizedText(
                                                                            observedTargetState === "absent"
                                                                                ? "catalog.ui.usage.detail.substitute_absent"
                                                                                : "catalog.ui.usage.detail.substitute_different",
                                                                            { kind: substituteLabel },
                                                                        );
                                            const prepareLabel =
                                                observedTargetState === "different"
                                                    ? text("catalog.ui.usage.review_difference")
                                                    : capability === "direct"
                                                      ? text("catalog.ui.usage.preview_write")
                                                      : text("catalog.ui.usage.review_conversion");
                                            const rowDiagnostics = uniqueProtocolDiagnostics([
                                                ...observation.diagnostics,
                                                ...row.analysisDiagnostics,
                                            ]);
                                            const failureStages = [
                                                ...new Set(rowDiagnostics.map((diagnostic) => diagnostic.operation)),
                                            ];
                                            const hasDiagnosticOutcome =
                                                rowDiagnostics.length > 0 &&
                                                (observation.state !== "ready" || row.analysisDiagnostics.length > 0);
                                            const observationDetail = (
                                                <div className="asset-usage-observation-detail-body">
                                                    <CatalogTargetTechnicalDetails
                                                        adapterId={observation.adapterId}
                                                        environment={observation}
                                                        agentRuntimeIds={[agentRuntimeId]}
                                                        displayPath={target?.displayPath}
                                                        checkedPaths={observation.checkedPaths}
                                                        failureStages={failureStages}
                                                        fact={
                                                            <small>
                                                                {viewMode === "adapter"
                                                                    ? `${target?.displayName ?? runtimeLabelForObservation(observation)} · ${displayText(
                                                                          presentDiscoveryEnvironment(observation),
                                                                      )}`
                                                                    : `${toolLabel(observation.adapterId)} · ${displayText(
                                                                          presentDiscoveryEnvironment(observation),
                                                                      )}`}
                                                            </small>
                                                        }
                                                    />
                                                    {hasDiagnosticOutcome ? null : (
                                                        <p
                                                            data-oaam-application-version-state={
                                                                relationship?.managedState === "applied" &&
                                                                observedTargetState === "already_usable"
                                                                    ? "current"
                                                                    : undefined
                                                            }
                                                        >
                                                            {displayText(detail)}
                                                        </p>
                                                    )}
                                                    {rowDiagnostics.length === 0 ? null : (
                                                        <div className="asset-usage-observation-diagnostics">
                                                            <ProtocolDiagnostics
                                                                embedded
                                                                diagnostics={rowDiagnostics}
                                                                operationMessage={
                                                                    hasDiagnosticOutcome &&
                                                                    observation.state !== "current_observation_failed" &&
                                                                    !(
                                                                        observation.state === "ready" &&
                                                                        rowDiagnostics.some(
                                                                            (diagnostic) => diagnostic.severity === "error",
                                                                        )
                                                                    )
                                                                        ? detail
                                                                        : undefined
                                                                }
                                                                singleItemContext
                                                                layout="grouped"
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                            return (
                                                <Fragment key={observation.key}>
                                                    {passiveObservation && rowIndex === available - passiveCount ? (
                                                        <li
                                                            className="asset-usage-secondary-disclosure"
                                                            data-oaam-passive-checks={passiveCount}
                                                        >
                                                            <button
                                                                data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_usage_relationships.004"
                                                                type="button"
                                                                aria-expanded={passiveExpanded}
                                                                onClick={() => toggleCompactGroup(passiveExpansionKey)}
                                                            >
                                                                {text("catalog.ui.usage.ready_checks", { count: passiveCount })}
                                                                <DesktopIcon
                                                                    name={passiveExpanded ? "chevron_down" : "chevron_right"}
                                                                    size={16}
                                                                />
                                                            </button>
                                                        </li>
                                                    ) : null}
                                                    {secondaryObservation && rowIndex === available ? (
                                                        <li
                                                            className="asset-usage-secondary-disclosure"
                                                            data-oaam-secondary-checks={secondaryCount}
                                                        >
                                                            <button
                                                                data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_usage_relationships.003"
                                                                type="button"
                                                                aria-expanded={secondaryExpanded}
                                                                onClick={() => toggleCompactGroup(secondaryExpansionKey)}
                                                            >
                                                                {text("catalog.ui.usage.other_checks", {
                                                                    count: secondaryCount,
                                                                })}
                                                                <DesktopIcon
                                                                    name={secondaryExpanded ? "chevron_down" : "chevron_right"}
                                                                    size={16}
                                                                />
                                                            </button>
                                                        </li>
                                                    ) : null}
                                                    <li
                                                        className="asset-usage-row"
                                                        hidden={
                                                            (secondaryObservation && !secondaryExpanded) ||
                                                            (passiveObservation && !passiveExpanded)
                                                        }
                                                        data-oaam-asset-usage-analysis={
                                                            rowPending ? "checking" : (analysisFailureKind ?? "complete")
                                                        }
                                                        data-oaam-asset-usage-capability={capability}
                                                        data-oaam-asset-usage-target-state={observedTargetState}
                                                        data-oaam-asset-usage-managed={relationship?.managedState ?? "none"}
                                                        data-oaam-deployment-id={deploymentId}
                                                        data-oaam-target-key={target?.key}
                                                        data-oaam-target-candidate-id={target?.targetCandidateId}
                                                        data-oaam-observation-key={observation.key}
                                                        data-oaam-adapter-id={observation.adapterId}
                                                        data-oaam-platform={observation.platform}
                                                        data-oaam-platform-instance-id={observation.platformInstanceId}
                                                        data-oaam-agent-runtime-id={agentRuntimeId}
                                                        data-oaam-runtime-version={observation.versionText}
                                                        data-oaam-target-observation-state={observation.state}
                                                        data-oaam-target-reason-codes={observation.reasonCodes.join(" ")}
                                                        data-oaam-secondary-observation={
                                                            secondaryObservation ? "true" : undefined
                                                        }
                                                    >
                                                        <div className="asset-usage-row-copy">
                                                            <div className="asset-usage-row-title">
                                                                <strong>{runtimeLabelForObservation(observation)}</strong>
                                                                <span
                                                                    className={`asset-usage-status asset-usage-status-${relationship?.managedState === "configured" ? "configured" : observedTargetState}`}
                                                                    data-oaam-application-state={
                                                                        relationship?.managedState === "applied" &&
                                                                        observedTargetState === "already_usable"
                                                                            ? "applied"
                                                                            : undefined
                                                                    }
                                                                >
                                                                    {statusLabel}
                                                                </span>
                                                                {ownsInstallationAction &&
                                                                onChooseInstallationRoot !== undefined ? (
                                                                    <button
                                                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_usage_relationships.001"
                                                                        type="button"
                                                                        className="library-secondary-button"
                                                                        disabled={installationLocationBusy || interactionLocked}
                                                                        onClick={() =>
                                                                            onChooseInstallationRoot(
                                                                                observation.adapterId,
                                                                                observation,
                                                                            )
                                                                        }
                                                                    >
                                                                        {text("catalog.ui.target.choose_installation")}
                                                                    </button>
                                                                ) : target === undefined ||
                                                                  rowPending ||
                                                                  analysisFailureKind !== undefined ? null : deploymentId !==
                                                                  undefined ? (
                                                                    <button
                                                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.004"
                                                                        data-oaam-action="select_existing_usage"
                                                                        type="button"
                                                                        className="library-secondary-button"
                                                                        disabled={interactionLocked}
                                                                        onClick={() => onOpenUsage(target, deploymentId)}
                                                                    >
                                                                        {text(
                                                                            savedVersionOnly
                                                                                ? "catalog.ui.usage.review_saved_version"
                                                                                : "catalog.ui.usage.open",
                                                                        )}
                                                                    </button>
                                                                ) : capability === "unavailable" ||
                                                                  observedTargetState === "already_usable" ||
                                                                  observedTargetState === "unknown" ? null : (
                                                                    <button
                                                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.003"
                                                                        data-oaam-action="create_deployment_review_intent"
                                                                        type="button"
                                                                        disabled={interactionLocked}
                                                                        onClick={() => onPrepare(target, agentRuntimeId)}
                                                                    >
                                                                        {prepareLabel}
                                                                    </button>
                                                                )}
                                                            </div>
                                                            {observationDetail}
                                                            {ownsInstallationAction &&
                                                            installationRootFailureKey === installationKey ? (
                                                                <small role="alert">
                                                                    {text("catalog.ui.target.installation_picker_failed")}
                                                                </small>
                                                            ) : null}
                                                        </div>
                                                    </li>
                                                </Fragment>
                                            );
                                        })}
                                    </ul>
                                ) : null}
                            </section>
                        );
                    })}
                </div>
            )}
        </WorkbenchPanel>
    );
}

interface CatalogDeploymentCreateReviewProps {
    readonly actions?: ReactNode;
    readonly controller: CatalogDeploymentController;
    readonly subject: DeploymentWorkspaceSubject;
    readonly asset: AssetSummaryView | undefined;
    readonly deployment: DeploymentView;
    readonly target: DeploymentTargetView | undefined;
    readonly providers: readonly AdapterProviderView[];
    readonly analysis: RenderAnalysisView | undefined;
    readonly targetObservationComplete: boolean;
    readonly disabled: boolean;
    readonly onOpenAssetUsage?: (assetId: string) => void;
    readonly onOpenLibrary?: () => void;
}

interface CreationPresentation {
    readonly displayText: (value: DesktopDisplayText) => string;
    readonly text: (id: DesktopMessageId, values?: DesktopMessageValues) => string;
}

export function catalogCreationMessage<T extends DesktopMessageId>(
    initialAssetId: string | undefined,
    ordinary: T,
    creation: T,
): T {
    return initialAssetId === undefined ? ordinary : creation;
}

export function catalogCreationRuntimeLabel(
    target: DeploymentTargetView | undefined,
    agentRuntimeId: string,
    providers: readonly AdapterProviderView[],
    presentation: CreationPresentation,
): string {
    const runtimeName = presentation.displayText(presentDiscoveryAgentRuntime(agentRuntimeId, providers).label);
    const runtime = target === undefined ? undefined : deploymentTargetRuntimeIdentity(target, agentRuntimeId);
    return runtime === undefined
        ? runtimeName
        : presentation.text("catalog.product.runtime_version", { runtime: runtimeName, version: runtime.versionText });
}

export function catalogCreationApplyLabel(
    target: DeploymentTargetView,
    providers: readonly AdapterProviderView[],
    presentation: CreationPresentation,
): string {
    return presentation.text("catalog.ui.action.apply_to_tool", {
        tool: presentation.displayText(presentDiscoveryTool(target.adapterId, providers).label),
    });
}

export function CatalogDeploymentActivityNotice({
    activity,
    creation,
}: {
    readonly activity: CatalogDeploymentActivity;
    readonly creation: boolean;
}): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    if (activity.status === "idle") return null;
    const message =
        !creation || activity.kind === "authorize"
            ? displayText(activity.message)
            : text(activity.kind === "deploy" ? "catalog.product.apply.waiting" : "catalog.product.review.waiting");
    const fact = (
        <span>
            {message}
            {activity.status === "progress" ? ` (${activity.completedUnits}/${activity.totalUnits})` : ""}
        </span>
    );
    return (
        <WorkbenchNotice role="status">
            {activity.operationId === undefined && activity.technicalStage === undefined ? (
                fact
            ) : (
                <CatalogActivityTechnicalDetails
                    fact={fact}
                    operationId={activity.operationId}
                    progressStage={activity.technicalStage}
                />
            )}
        </WorkbenchNotice>
    );
}

export function CatalogDeploymentAnalysisNotice({
    analysis,
    deploymentId,
    creation,
    activityVisible = false,
    diagnostics = [],
}: {
    readonly analysis: DeploymentAnalysisState;
    readonly deploymentId: string;
    readonly creation: boolean;
    readonly activityVisible?: boolean;
    readonly diagnostics?: readonly ProtocolDiagnosticV1[];
}): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    if (analysis.status === "loading" && analysis.deploymentId === deploymentId) {
        if (activityVisible) return null;
        return (
            <WorkbenchNotice role="status">
                {text(creation ? "catalog.product.review.waiting" : "catalog.ui.render.waiting")}
            </WorkbenchNotice>
        );
    }
    if (analysis.status !== "failed" || analysis.deploymentId !== deploymentId) return null;
    return (
        <WorkbenchNotice
            tone="danger"
            role="alert"
            data-oaam-operation-state={catalogDeploymentFailurePresentationState(analysis.failureKind)}
        >
            <p>{creation ? text("catalog.product.analysis.failed") : displayText(analysis.message)}</p>
            <ProtocolDiagnostics embedded diagnostics={diagnostics} />
        </WorkbenchNotice>
    );
}

export function CatalogDeploymentCreateReview({
    actions,
    controller,
    subject,
    asset,
    deployment,
    target,
    providers,
    analysis,
    targetObservationComplete,
    disabled,
    onOpenAssetUsage,
    onOpenLibrary,
}: CatalogDeploymentCreateReviewProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const runtimeId = deployment.consumerAgentRuntimeIds.length === 1 ? deployment.consumerAgentRuntimeIds[0] : undefined;
    const runtime =
        runtimeId === undefined || target === undefined ? undefined : deploymentTargetRuntimeIdentity(target, runtimeId);
    const runtimeLabel =
        runtimeId === undefined ? "" : catalogCreationRuntimeLabel(target, runtimeId, providers, { displayText, text });
    const compatibilityWarning =
        runtimeId === "CLAUDE_CODE_CLI" &&
        runtime !== undefined &&
        analysis?.diagnostics.some(
            (diagnostic) =>
                diagnostic.code === "claudecode_target_build_compatibility_inferred" && diagnostic.severity === "warning",
        ) === true;
    const authorization: CurrentProjectPromotionAuthorization = currentProjectPromotionAuthorization({
        subject,
        target,
        deployment,
        asset,
        analysis,
    });
    const hasAuthorizationFallback =
        authorization.status === "not_applicable" &&
        analysis?.deploymentId === deployment.deploymentId &&
        analysis.promotionAuthorizationInspections.some(
            (inspection) =>
                inspection.promotionAuthorizationState === "required" || inspection.promotionAuthorizationState === "unavailable",
        );
    return (
        <div
            className="deployment-create-target-card"
            data-oaam-create-target-review
            data-oaam-promotion-authorization={authorization.status === "authorized" ? "allowed" : undefined}
        >
            <div
                className="deployment-create-target-summary"
                data-oaam-deployment-id={deployment.deploymentId}
                data-oaam-target-key={target?.key}
                data-oaam-agent-runtime-id={runtimeId}
                data-oaam-runtime-version={runtime?.versionText}
            >
                <div className="asset-usage-row-title">
                    <strong>{runtimeLabel}</strong>
                </div>
                {target === undefined || runtimeId === undefined ? (
                    <small>{displayText(presentDiscoveryEnvironment(deployment.environment))}</small>
                ) : (
                    <CatalogTargetTechnicalDetails
                        adapterId={target.adapterId}
                        agentRuntimeIds={[runtimeId]}
                        displayPath={deployment.targetRootPath}
                        environment={deployment.environment}
                        fact={
                            <small>
                                {target.displayName} · {displayText(presentDiscoveryEnvironment(deployment.environment))}
                            </small>
                        }
                    />
                )}
            </div>
            {hasAuthorizationFallback ? (
                <CatalogDeploymentAuthorizationFallback
                    subject={subject}
                    asset={asset}
                    deployment={deployment}
                    analysis={analysis}
                    disabled={disabled}
                    onRetry={() => void controller.analyze(deployment.deploymentId)}
                    onOpenAssetUsage={onOpenAssetUsage}
                    onOpenLibrary={onOpenLibrary}
                />
            ) : null}
            {runtime === undefined && targetObservationComplete ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {text("catalog.authorization.target_changed")}
                </WorkbenchNotice>
            ) : runtime === undefined && !hasAuthorizationFallback ? (
                <WorkbenchNotice role="status">{text("catalog.authorization.target_check_required")}</WorkbenchNotice>
            ) : null}
            {authorization.status === "unavailable" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    <span>{text("catalog.authorization.check_failed")}</span>
                    <button
                        type="button"
                        className="library-secondary-button"
                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.026"
                        disabled={disabled}
                        onClick={() => void controller.analyze(deployment.deploymentId)}
                    >
                        {text("common.retry")}
                    </button>
                </WorkbenchNotice>
            ) : null}
            {authorization.status === "invalid" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {text("catalog.authorization.target_changed")}
                </WorkbenchNotice>
            ) : authorization.status === "required" && target !== undefined ? (
                <WorkbenchNotice data-oaam-promotion-authorization="required" tone="warning" role="status">
                    <p>{text("catalog.authorization.required")}</p>
                    <button
                        type="button"
                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.027"
                        data-oaam-action="save_promotion_grant"
                        data-oaam-deployment-action="authorize-current-version"
                        disabled={disabled}
                        onClick={() =>
                            void controller.authorizeCurrentVersionForProject(
                                {
                                    assetId: authorization.assetId,
                                    versionId: authorization.versionId,
                                    projectId: authorization.projectId,
                                },
                                deployment.deploymentId,
                                target,
                            )
                        }
                    >
                        {text("catalog.authorization.allow_current_project")}
                    </button>
                </WorkbenchNotice>
            ) : null}
            {compatibilityWarning ? (
                <WorkbenchNotice data-oaam-build-compatibility="newer-compatible" tone="warning" role="status">
                    {text("catalog.compatibility.newer_build", { runtime: runtimeLabel })}
                </WorkbenchNotice>
            ) : null}
            {actions}
        </div>
    );
}
