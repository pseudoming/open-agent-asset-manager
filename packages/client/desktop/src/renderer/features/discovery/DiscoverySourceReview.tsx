import { DiscoverySourceRuntimeSelection } from "./DiscoverySourceRuntimeSelection";
import { projectDisplayName } from "../../presentation/project-label";
import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { useState } from "react";
import { ProtocolDiagnostics, technicalText, useDesktopPresentation } from "../../presentation";
import { WorkbenchBadge, WorkbenchNotice, WorkbenchRadioButton, WorkbenchSelect, WorkbenchTechnicalFact } from "../../ui";
import type {
    AdapterProviderView,
    DiscoveryProjectProposal,
    DiscoverySourceClaimGroup,
    DiscoveryWatchBinding,
    DiscoveryWatchSelection,
    ProjectListView,
} from "./discovery-model";
import {
    discoveryProjectProposalForSourceGroup,
    discoverySourceGroupDefaultsIncluded,
    discoveryWatchBindingForInclusion,
} from "./discovery-model";
import {
    discoverySourceStatusMessage,
    discoverySourceStatusTone,
    presentDiscoveryEnvironment,
    presentDiscoveryPath,
    presentDiscoverySourceRelationship,
    presentDiscoveryTool,
} from "./discovery-presentation";

export interface DiscoverySourceReviewProps {
    readonly busy: boolean;
    readonly purpose?: "import" | "manage_locations";
    readonly groups: readonly DiscoverySourceClaimGroup[];
    readonly projectDecisions?: ReadonlyMap<string, "added" | "skipped">;
    readonly projectErrorKey?: string;
    readonly projectErrorMessage?: string;
    readonly projectErrorDiagnostics?: readonly ProtocolDiagnosticV1[];
    readonly projectPendingKey?: string;
    readonly projectProposals?: readonly DiscoveryProjectProposal[];
    readonly projects: ProjectListView["projects"];
    readonly providers: readonly AdapterProviderView[];
    readonly selectedSourceKeys: readonly string[];
    readonly readAgentRuntimeIdsBySource?: ReadonlyMap<string, string>;
    readonly onReadAgentRuntimeIdChange?: (sourceKey: string, agentRuntimeId: string | undefined) => void;
    readonly watchSelections: readonly DiscoveryWatchSelection[];
    readonly onAddProjectProposal?: (proposal: DiscoveryProjectProposal) => void;
    readonly onProjectProposalSkippedChange?: (proposal: DiscoveryProjectProposal, skipped: boolean) => void;
    readonly onPersistWatchSelections?: (
        selections: readonly DiscoveryWatchSelection[],
        explicitlyExcludedSourceKeys?: readonly string[],
    ) => Promise<boolean>;
    readonly onSelectedSourceKeysChange?: (keys: readonly string[]) => void;
    readonly onWatchSelectionsChange: (selections: readonly DiscoveryWatchSelection[]) => void;
}

function bindingValue(binding: DiscoveryWatchBinding): string {
    return binding.assetScope === "global" ? "global" : `project:${binding.projectId}`;
}

function bindingFromValue(value: string): DiscoveryWatchBinding | undefined {
    if (value === "global") return { assetScope: "global" };
    return value.startsWith("project:") ? { assetScope: "project", projectId: value.slice("project:".length) } : undefined;
}

function sameBinding(left: DiscoveryWatchBinding, right: DiscoveryWatchBinding): boolean {
    return (
        left.assetScope === right.assetScope &&
        (left.assetScope === "global" || (right.assetScope === "project" && left.projectId === right.projectId))
    );
}

function hasProjectEvidence(group: DiscoverySourceClaimGroup): boolean {
    return group.claims.some(
        (claim) =>
            claim.source.rootRole === "project_actual" ||
            claim.source.sourceDomain === "project_root" ||
            claim.source.sourceDomain === "project_keyed",
    );
}

export function DiscoverySourceReview({
    busy,
    purpose = "import",
    groups,
    projectDecisions = new Map(),
    projectErrorKey,
    projectErrorMessage,
    projectErrorDiagnostics = [],
    projectPendingKey,
    projectProposals = [],
    projects,
    providers,
    selectedSourceKeys,
    readAgentRuntimeIdsBySource = new Map(),
    onReadAgentRuntimeIdChange,
    watchSelections,
    onAddProjectProposal,
    onProjectProposalSkippedChange,
    onPersistWatchSelections,
    onSelectedSourceKeysChange,
    onWatchSelectionsChange,
}: DiscoverySourceReviewProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const [pendingIgnoreKey, setPendingIgnoreKey] = useState<string>();
    const [ignoredGroupKeys, setIgnoredGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
    const [restoringGroupKeys, setRestoringGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
    const [editingDestinationKey, setEditingDestinationKey] = useState<string>();
    const [lastProjectBindings, setLastProjectBindings] = useState<ReadonlyMap<string, DiscoveryWatchBinding>>(() => new Map());
    const selectedKeySet = new Set(selectedSourceKeys);

    return (
        <ul className="source-review-list">
            {groups.map((group) => {
                const presentedPath = presentDiscoveryPath(group.displayPath, group.environment);
                const presentedPriorPath = presentDiscoveryPath(group.priorDisplayPath, group.environment);
                const groupSourceKeys = new Set(group.claims.map((claim) => claim.source.key));
                const reviewable = group.reviewSourceKeys;
                const selected = reviewable.length > 0 && reviewable.every((key) => selectedKeySet.has(key));
                const environmentLabel = presentDiscoveryEnvironment(group.environment);
                const toolLabels = group.claims.map((claim) =>
                    displayText(presentDiscoveryTool(claim.source.adapterId, providers).label),
                );
                const groupWatchSelections = watchSelections.filter((selection) => groupSourceKeys.has(selection.sourceKey));
                const firstGroupWatchSelection = groupWatchSelections[0];
                const groupWatchBindingConflict =
                    firstGroupWatchSelection !== undefined &&
                    !groupWatchSelections.every((selection) => sameBinding(firstGroupWatchSelection.binding, selection.binding));
                const groupWatchBinding =
                    firstGroupWatchSelection !== undefined && !groupWatchBindingConflict
                        ? firstGroupWatchSelection.binding
                        : undefined;
                const futureScanEnabled = groupWatchBindingConflict || groupWatchBinding !== undefined;
                const watchSource = group.claims.find((claim) => claim.source.key === group.watchSourceKey)?.source;
                const watchAvailability = watchSource?.watchAvailability;
                const inclusionWatchBinding = discoveryWatchBindingForInclusion(group, projects);
                const projectProposal = discoveryProjectProposalForSourceGroup(group, projectProposals);
                const projectDecision = projectProposal === undefined ? undefined : projectDecisions.get(projectProposal.key);
                const unregisteredProjectProposal =
                    projectProposal !== undefined &&
                    projectProposal.matchedProjectId === undefined &&
                    projectDecision !== "added" &&
                    projectDecision !== "skipped"
                        ? projectProposal
                        : undefined;
                const priorExcluded = group.claims.some(
                    (claim) =>
                        claim.source.watchAvailability.status === "selectable" &&
                        claim.source.watchAvailability.prior?.disposition === "excluded",
                );
                const defaultIncluded = discoverySourceGroupDefaultsIncluded(group);
                const restoring = restoringGroupKeys.has(group.key);
                const ignored =
                    (!restoring && ignoredGroupKeys.has(group.key)) ||
                    (!restoring && projectDecision === "skipped") ||
                    (!restoring && priorExcluded && !selected && !futureScanEnabled);
                const needsReview =
                    !ignored &&
                    (purpose === "manage_locations"
                        ? !futureScanEnabled && watchAvailability?.status === "selectable"
                        : !selected && reviewable.length > 0);
                const active =
                    !ignored &&
                    (purpose === "manage_locations"
                        ? futureScanEnabled
                        : selected || (futureScanEnabled && reviewable.length === 0));
                const priorProjectId =
                    watchAvailability?.status === "selectable" && watchAvailability.prior?.binding?.assetScope === "project"
                        ? watchAvailability.prior.binding.projectId
                        : undefined;
                const priorProjectIsKnown =
                    priorProjectId !== undefined && projects.some((project) => project.projectId === priorProjectId);
                const watchOptions =
                    watchAvailability?.status !== "selectable"
                        ? []
                        : [
                              ...(watchAvailability.observed !== undefined ||
                              watchAvailability.prior?.binding?.assetScope === "global"
                                  ? [{ value: "global", label: text("discovery.product.follow.global") }]
                                  : []),
                              ...(priorProjectId !== undefined && !priorProjectIsKnown
                                  ? [
                                        {
                                            value: `project:${priorProjectId}`,
                                            label: text("discovery.product.follow.project_unavailable"),
                                        },
                                    ]
                                  : []),
                              ...projects.flatMap((project) =>
                                  !project.deleted &&
                                  (watchAvailability.observed !== undefined ||
                                      (watchAvailability.prior?.binding?.assetScope === "project" &&
                                          watchAvailability.prior.binding.projectId === project.projectId))
                                      ? [
                                            {
                                                value: `project:${project.projectId}`,
                                                label: text("discovery.product.follow.project", {
                                                    project: projectDisplayName(project),
                                                }),
                                            },
                                        ]
                                      : [],
                              ),
                          ];
                const showStatus = group.status !== "current" && group.status !== "new";
                const diagnostics = group.claims.flatMap((claim) => claim.source.diagnostics);
                const ambiguousClaim = group.claims.find((claim) => claim.claimKind === "ambiguous_private");
                const ambiguousRelationship =
                    ambiguousClaim === undefined ? undefined : presentDiscoverySourceRelationship(ambiguousClaim.claimKind);
                const destination = groupWatchBindingConflict
                    ? text("discovery.product.follow.mixed")
                    : editingDestinationKey === group.key
                      ? text("discovery.product.follow.destination_pending")
                      : groupWatchBinding?.assetScope === "global"
                        ? text("discovery.product.follow.destination_global")
                        : groupWatchBinding?.assetScope === "project"
                          ? text("discovery.product.follow.destination_project", {
                                project:
                                    projectDisplayName(
                                        projects.find((project) => project.projectId === groupWatchBinding.projectId),
                                    ) ?? text("discovery.product.follow.project_unavailable"),
                            })
                          : hasProjectEvidence(group)
                            ? text("discovery.product.follow.destination_pending")
                            : text("discovery.product.follow.none");
                const nextWithoutGroup = watchSelections.filter((selection) => !groupSourceKeys.has(selection.sourceKey));
                const globalWatchOption = watchOptions.find((option) => option.value === "global");
                const projectWatchOptions = watchOptions.filter((option) => option.value.startsWith("project:"));
                const rememberedProjectBinding = lastProjectBindings.get(group.key);
                const matchedProjectBinding =
                    projectProposal?.matchedProjectId === undefined
                        ? undefined
                        : ({ assetScope: "project", projectId: projectProposal.matchedProjectId } as const);
                const availableProjectBinding = (
                    binding: DiscoveryWatchBinding | undefined,
                ): DiscoveryWatchBinding | undefined =>
                    binding?.assetScope === "project" &&
                    projectWatchOptions.some((option) => option.value === bindingValue(binding))
                        ? binding
                        : undefined;
                const preferredProjectBinding =
                    availableProjectBinding(rememberedProjectBinding) ?? availableProjectBinding(matchedProjectBinding);
                const retainedProjectBinding =
                    unregisteredProjectProposal?.matchedRetainedProjectId !== undefined &&
                    groupWatchBinding?.assetScope === "project" &&
                    groupWatchBinding.projectId === unregisteredProjectProposal.matchedRetainedProjectId;
                const pendingProjectDestination =
                    unregisteredProjectProposal !== undefined &&
                    (groupWatchBinding === undefined || retainedProjectBinding) &&
                    !groupWatchBindingConflict;
                const editingProjectDestination = editingDestinationKey === group.key;
                const projectDestinationAvailable = projectWatchOptions.length > 0 || unregisteredProjectProposal !== undefined;
                const currentProjectName =
                    groupWatchBinding?.assetScope === "project"
                        ? (projectDisplayName(projects.find((project) => project.projectId === groupWatchBinding.projectId)) ??
                          (retainedProjectBinding ? unregisteredProjectProposal.displayName : undefined) ??
                          text("discovery.product.follow.project_unavailable"))
                        : pendingProjectDestination
                          ? unregisteredProjectProposal.displayName
                          : undefined;
                const destinationAttention = groupWatchBindingConflict
                    ? text("discovery.product.follow.mixed")
                    : groupWatchBinding === undefined && hasProjectEvidence(group)
                      ? text("discovery.product.follow.destination_pending")
                      : undefined;
                const projectUnavailableReason =
                    !projectDestinationAvailable && !groupWatchBindingConflict
                        ? text("discovery.product.follow.project_requires_registered")
                        : undefined;
                const applyWatchBinding = (binding: DiscoveryWatchBinding): void => {
                    if (watchSource === undefined) return;
                    onWatchSelectionsChange([...nextWithoutGroup, { sourceKey: watchSource.key, binding }]);
                };
                const rememberProjectBinding = (binding: DiscoveryWatchBinding): void => {
                    if (binding.assetScope !== "project") return;
                    setLastProjectBindings((current) => {
                        const next = new Map(current);
                        next.set(group.key, binding);
                        return next;
                    });
                };
                const chooseGlobalLibrary = (): void => {
                    if (globalWatchOption === undefined) return;
                    if (groupWatchBinding?.assetScope === "project") rememberProjectBinding(groupWatchBinding);
                    applyWatchBinding({ assetScope: "global" });
                    setEditingDestinationKey(undefined);
                };
                const chooseProjectLibrary = (): void => {
                    if (!projectDestinationAvailable) return;
                    if (groupWatchBinding?.assetScope === "project") {
                        if (projectWatchOptions.length > 1) {
                            setEditingDestinationKey((current) => (current === group.key ? undefined : group.key));
                        }
                        return;
                    }
                    if (preferredProjectBinding !== undefined) {
                        applyWatchBinding(preferredProjectBinding);
                        rememberProjectBinding(preferredProjectBinding);
                        setEditingDestinationKey(undefined);
                        return;
                    }
                    if (unregisteredProjectProposal !== undefined) {
                        onWatchSelectionsChange(nextWithoutGroup);
                        setEditingDestinationKey(undefined);
                        return;
                    }
                    const soleProjectOption = projectWatchOptions.length === 1 ? projectWatchOptions[0] : undefined;
                    const soleProjectBinding =
                        soleProjectOption === undefined ? undefined : bindingFromValue(soleProjectOption.value);
                    if (soleProjectBinding !== undefined) {
                        applyWatchBinding(soleProjectBinding);
                        rememberProjectBinding(soleProjectBinding);
                        setEditingDestinationKey(undefined);
                        return;
                    }
                    onWatchSelectionsChange(nextWithoutGroup);
                    setEditingDestinationKey(group.key);
                };
                const includeGroup = async (): Promise<void> => {
                    const priorSelectedSourceKeys = selectedSourceKeys;
                    const priorWatchSelections = watchSelections;
                    const wasIgnored = ignored;
                    const nextSelectedSourceKeys = [
                        ...selectedSourceKeys.filter((key) => !groupSourceKeys.has(key)),
                        ...reviewable,
                    ];
                    const requestedBinding = groupWatchBinding ?? inclusionWatchBinding;
                    if (purpose === "manage_locations" && requestedBinding === undefined) {
                        setIgnoredGroupKeys((current) => {
                            const next = new Set(current);
                            next.delete(group.key);
                            return next;
                        });
                        setRestoringGroupKeys((current) => new Set(current).add(group.key));
                        if (projectProposal !== undefined) onProjectProposalSkippedChange?.(projectProposal, false);
                        setPendingIgnoreKey(undefined);
                        return;
                    }
                    const nextWatchSelections =
                        watchSource !== undefined && requestedBinding !== undefined
                            ? [...nextWithoutGroup, { sourceKey: watchSource.key, binding: requestedBinding }]
                            : nextWithoutGroup;
                    if (onSelectedSourceKeysChange !== undefined) {
                        onSelectedSourceKeysChange(nextSelectedSourceKeys);
                    }
                    onWatchSelectionsChange(nextWatchSelections);
                    setIgnoredGroupKeys((current) => {
                        const next = new Set(current);
                        next.delete(group.key);
                        return next;
                    });
                    setRestoringGroupKeys((current) => {
                        const next = new Set(current);
                        next.delete(group.key);
                        return next;
                    });
                    if (projectProposal !== undefined) onProjectProposalSkippedChange?.(projectProposal, false);
                    setPendingIgnoreKey(undefined);
                    if (onPersistWatchSelections === undefined || (await onPersistWatchSelections(nextWatchSelections))) return;
                    onSelectedSourceKeysChange?.(priorSelectedSourceKeys);
                    onWatchSelectionsChange(priorWatchSelections);
                    if (wasIgnored) setIgnoredGroupKeys((current) => new Set(current).add(group.key));
                    if (projectProposal !== undefined && projectDecision === "skipped") {
                        onProjectProposalSkippedChange?.(projectProposal, true);
                    }
                };
                const ignoreGroup = async (): Promise<void> => {
                    const priorSelectedSourceKeys = selectedSourceKeys;
                    const priorWatchSelections = watchSelections;
                    if (onSelectedSourceKeysChange !== undefined) {
                        onSelectedSourceKeysChange(selectedSourceKeys.filter((key) => !groupSourceKeys.has(key)));
                    }
                    onWatchSelectionsChange(nextWithoutGroup);
                    setIgnoredGroupKeys((current) => new Set(current).add(group.key));
                    setRestoringGroupKeys((current) => {
                        const next = new Set(current);
                        next.delete(group.key);
                        return next;
                    });
                    if (projectProposal !== undefined) onProjectProposalSkippedChange?.(projectProposal, true);
                    setPendingIgnoreKey(undefined);
                    setEditingDestinationKey(undefined);
                    const explicitlyExcludedSourceKeys = group.claims.flatMap((claim) =>
                        claim.source.watchAvailability.status === "selectable" ? [claim.source.key] : [],
                    );
                    if (
                        onPersistWatchSelections === undefined ||
                        (await onPersistWatchSelections(nextWithoutGroup, explicitlyExcludedSourceKeys))
                    ) {
                        return;
                    }
                    onSelectedSourceKeysChange?.(priorSelectedSourceKeys);
                    onWatchSelectionsChange(priorWatchSelections);
                    setIgnoredGroupKeys((current) => {
                        const next = new Set(current);
                        next.delete(group.key);
                        return next;
                    });
                    if (projectProposal !== undefined) onProjectProposalSkippedChange?.(projectProposal, false);
                    setPendingIgnoreKey(group.key);
                };
                const metadataTags = (
                    <span className="source-metadata-tags">
                        <WorkbenchBadge tone="neutral">{displayText(environmentLabel)}</WorkbenchBadge>
                        {[...new Set(toolLabels)].map((label) => (
                            <WorkbenchBadge key={label} tone="neutral">
                                {label}
                            </WorkbenchBadge>
                        ))}
                    </span>
                );
                const technicalDetails = ignored ? (
                    metadataTags
                ) : (
                    <WorkbenchTechnicalFact
                        data-oaam-interaction-entry="features.discovery.discovery_source_review.011"
                        disclosureClassName="source-technical-details"
                        fact={metadataTags}
                        summary={text("discovery.product.source.details")}
                    >
                        <ProtocolDiagnostics diagnostics={diagnostics} layout="grouped" />
                        {group.claims.map((claim) => {
                            const source = claim.source;
                            const tool = presentDiscoveryTool(source.adapterId, providers);
                            return (
                                <article key={source.key}>
                                    <strong>{displayText(tool.label)}</strong>
                                    <code>
                                        {text("discovery.product.technical.identity", {
                                            identity: tool.technicalIdentity,
                                        })}
                                    </code>
                                    <code>{source.agentRuntimeIds.join(", ")}</code>
                                    <code>
                                        {source.sourceDomain} · {source.rootRole} · {source.accessStatus}
                                    </code>
                                    <small>{displayText(technicalText(source.key))}</small>
                                </article>
                            );
                        })}
                    </WorkbenchTechnicalFact>
                );
                const showProjectPicker =
                    projectWatchOptions.length > 0 &&
                    (editingDestinationKey === group.key ||
                        (groupWatchBinding?.assetScope === "project" && projectWatchOptions.length > 1));
                const destinationControl = (
                    <div className="source-destination-control">
                        <div className="source-watch-destination" data-oaam-source-destination={destination}>
                            <div
                                className="source-destination-switch"
                                role="radiogroup"
                                aria-label={text("discovery.product.follow.destination")}
                            >
                                <WorkbenchRadioButton
                                    data-oaam-interaction-entry="features.discovery.discovery_source_review.001"
                                    data-oaam-source-destination-choice="global"
                                    checked={
                                        !groupWatchBindingConflict &&
                                        !editingProjectDestination &&
                                        groupWatchBinding?.assetScope === "global"
                                    }
                                    disabled={busy || globalWatchOption === undefined}
                                    inputLabel={text("discovery.product.follow.global")}
                                    name={`source-destination-${group.key}`}
                                    onCheckedChange={chooseGlobalLibrary}
                                    value="global"
                                >
                                    {text("discovery.product.follow.global")}
                                </WorkbenchRadioButton>
                                <WorkbenchRadioButton
                                    data-oaam-interaction-entry="features.discovery.discovery_source_review.002"
                                    data-oaam-source-destination-choice="project"
                                    data-oaam-source-destination-pending={
                                        editingDestinationKey === group.key && groupWatchBinding?.assetScope !== "project"
                                            ? "true"
                                            : undefined
                                    }
                                    checked={
                                        !groupWatchBindingConflict &&
                                        (groupWatchBinding?.assetScope === "project" ||
                                            pendingProjectDestination ||
                                            editingProjectDestination)
                                    }
                                    disabled={busy || !projectDestinationAvailable}
                                    inputLabel={text("discovery.product.follow.project_library")}
                                    name={`source-destination-${group.key}`}
                                    onCheckedChange={chooseProjectLibrary}
                                    value="project"
                                >
                                    {text("discovery.product.follow.project_library")}
                                </WorkbenchRadioButton>
                            </div>
                            {(currentProjectName === undefined || showProjectPicker) &&
                            destinationAttention === undefined &&
                            projectUnavailableReason === undefined ? null : (
                                <small
                                    className="source-destination-current"
                                    data-oaam-source-project-unavailable={
                                        projectUnavailableReason === undefined ? undefined : "true"
                                    }
                                >
                                    {currentProjectName ?? destinationAttention ?? projectUnavailableReason}
                                </small>
                            )}
                        </div>
                        {!showProjectPicker ? null : (
                            <WorkbenchSelect
                                data-oaam-interaction-entry="features.discovery.discovery_source_review.003"
                                label={text("discovery.product.follow.choose_project")}
                                disabled={busy}
                                value={groupWatchBinding?.assetScope === "project" ? bindingValue(groupWatchBinding) : ""}
                                options={[
                                    ...(groupWatchBinding?.assetScope === "project"
                                        ? []
                                        : [
                                              {
                                                  value: "",
                                                  label: text("discovery.product.follow.choose_project"),
                                                  disabled: true,
                                              },
                                          ]),
                                    ...projectWatchOptions,
                                ]}
                                onChange={(value) => {
                                    const binding = bindingFromValue(value);
                                    if (binding === undefined) return;
                                    applyWatchBinding(binding);
                                    rememberProjectBinding(binding);
                                    setEditingDestinationKey(undefined);
                                }}
                            />
                        )}
                        {!pendingProjectDestination || unregisteredProjectProposal === undefined ? null : (
                            <div
                                aria-busy={projectPendingKey === unregisteredProjectProposal.key ? "true" : undefined}
                                className="source-project-proposal"
                                data-oaam-project-proposal-key={unregisteredProjectProposal.key}
                            >
                                <span>
                                    <small>
                                        {text(
                                            unregisteredProjectProposal.matchedRetainedProjectId === undefined
                                                ? "import_journey.projects.pending"
                                                : "import_journey.projects.retained_pending",
                                        )}
                                    </small>
                                </span>
                                <button
                                    data-oaam-interaction-entry="features.discovery.discovery_source_review.004"
                                    type="button"
                                    className="source-project-register-button"
                                    data-oaam-project-decision="add"
                                    data-oaam-project-lifecycle-action={
                                        unregisteredProjectProposal.matchedRetainedProjectId === undefined ? undefined : "restore"
                                    }
                                    data-oaam-project-registration-state={
                                        projectPendingKey === unregisteredProjectProposal.key
                                            ? "pending"
                                            : projectPendingKey === undefined
                                              ? "idle"
                                              : "blocked_by_other"
                                    }
                                    disabled={
                                        busy ||
                                        projectPendingKey !== undefined ||
                                        onAddProjectProposal === undefined ||
                                        (unregisteredProjectProposal.matchedRetainedProjectId === undefined &&
                                            unregisteredProjectProposal.registrationReference === undefined)
                                    }
                                    onClick={() => onAddProjectProposal?.(unregisteredProjectProposal)}
                                    title={
                                        projectPendingKey !== undefined && projectPendingKey !== unregisteredProjectProposal.key
                                            ? text("import_journey.projects.wait_for_other")
                                            : undefined
                                    }
                                >
                                    {text(
                                        projectPendingKey === unregisteredProjectProposal.key
                                            ? unregisteredProjectProposal.matchedRetainedProjectId === undefined
                                                ? "import_journey.projects.adding"
                                                : "import_journey.projects.restoring"
                                            : unregisteredProjectProposal.matchedRetainedProjectId === undefined
                                              ? "import_journey.projects.add"
                                              : "import_journey.projects.restore",
                                    )}
                                </button>
                                {projectErrorKey === unregisteredProjectProposal.key ? (
                                    projectErrorDiagnostics.length > 0 ? (
                                        <div role="alert">
                                            <ProtocolDiagnostics diagnostics={projectErrorDiagnostics} layout="grouped" />
                                        </div>
                                    ) : (
                                        <WorkbenchNotice tone="danger" role="alert">
                                            {projectErrorMessage}
                                        </WorkbenchNotice>
                                    )
                                ) : null}
                            </div>
                        )}
                    </div>
                );

                return (
                    <li
                        className="source-review-card"
                        data-oaam-source-claim-kinds={JSON.stringify(group.claims.map((claim) => claim.claimKind))}
                        data-oaam-source-adapter-ids={JSON.stringify(
                            [...new Set(group.claims.map((claim) => claim.source.adapterId))].sort(),
                        )}
                        data-oaam-source-environment={group.environmentLabel}
                        data-oaam-source-environment-key={JSON.stringify([
                            group.environment.platform,
                            group.environment.platformInstanceId,
                        ])}
                        data-oaam-source-path={group.displayPath}
                        data-oaam-source-default-included={defaultIncluded ? "true" : "false"}
                        data-oaam-source-selected={selected ? "true" : "false"}
                        data-oaam-source-watch-selected={futureScanEnabled ? "true" : "false"}
                        data-oaam-project-proposal-key={projectProposal?.key}
                        data-oaam-project-adapter-ids={
                            projectProposal === undefined ? undefined : JSON.stringify(projectProposal.adapterIds)
                        }
                        data-oaam-source-state={
                            ignored ? "ignored" : needsReview ? "requires_review" : active ? "included" : "unavailable"
                        }
                        key={group.key}
                    >
                        <div className="source-review-heading">
                            <div className="source-review-heading-copy">
                                <strong>
                                    <code>{presentedPath}</code>
                                </strong>
                                <div className="source-review-meta-line">{technicalDetails}</div>
                            </div>
                            {ignored ? (
                                <span className="source-review-ignored-actions">
                                    <WorkbenchBadge tone="neutral">{text("discovery.product.source.ignored")}</WorkbenchBadge>
                                    <button
                                        data-oaam-interaction-entry="features.discovery.discovery_source_review.005"
                                        type="button"
                                        className="library-secondary-button source-restore-button"
                                        data-oaam-source-action="restore"
                                        disabled={busy}
                                        onClick={() => void includeGroup()}
                                    >
                                        {text("discovery.product.source.restore")}
                                    </button>
                                </span>
                            ) : showStatus ? (
                                <WorkbenchBadge tone={discoverySourceStatusTone(group.status)}>
                                    {text(discoverySourceStatusMessage(group.status))}
                                </WorkbenchBadge>
                            ) : null}
                        </div>
                        {ignored ? (
                            <small className="source-ignored-effect">{text("discovery.product.source.ignored_effect")}</small>
                        ) : null}
                        {ignored || onReadAgentRuntimeIdChange === undefined ? null : (
                            <DiscoverySourceRuntimeSelection
                                group={group}
                                providers={providers}
                                selectedSourceKeys={selectedKeySet}
                                choices={readAgentRuntimeIdsBySource}
                                busy={busy}
                                onChange={onReadAgentRuntimeIdChange}
                            />
                        )}
                        {group.status === "moved" ? (
                            <small>
                                {text("discovery.ui.source.moved_from", {
                                    path: presentedPriorPath,
                                })}
                            </small>
                        ) : null}
                        {ambiguousRelationship === undefined ? null : (
                            <div className="source-relationship-list">
                                <div className="source-relationship" data-oaam-source-claim-kind="ambiguous_private">
                                    <WorkbenchBadge tone={ambiguousRelationship.tone}>
                                        {text(ambiguousRelationship.labelId)}
                                    </WorkbenchBadge>
                                    <small>{text(ambiguousRelationship.descriptionId)}</small>
                                </div>
                            </div>
                        )}
                        {ignored ? null : needsReview ? (
                            <div
                                className="source-review-decisions"
                                data-oaam-source-control-layout={
                                    futureScanEnabled || purpose === "manage_locations"
                                        ? "destination_and_actions"
                                        : "actions_only"
                                }
                            >
                                {futureScanEnabled || purpose === "manage_locations" ? destinationControl : null}
                                <span className="source-review-actions">
                                    {purpose === "manage_locations" &&
                                    groupWatchBinding === undefined &&
                                    inclusionWatchBinding === undefined ? null : (
                                        <button
                                            data-oaam-interaction-entry="features.discovery.discovery_source_review.006"
                                            type="button"
                                            className="library-secondary-button"
                                            data-oaam-source-action="include"
                                            disabled={busy}
                                            onClick={() => void includeGroup()}
                                        >
                                            {text("discovery.product.source.include")}
                                        </button>
                                    )}
                                    <button
                                        data-oaam-interaction-entry="features.discovery.discovery_source_review.007"
                                        type="button"
                                        className="source-ignore-button"
                                        data-oaam-source-action="ignore"
                                        data-oaam-project-decision={
                                            unregisteredProjectProposal === undefined ? undefined : "skip"
                                        }
                                        disabled={busy}
                                        onClick={() => setPendingIgnoreKey(group.key)}
                                    >
                                        {text("discovery.product.source.ignore")}
                                    </button>
                                </span>
                            </div>
                        ) : active ? (
                            <div className="source-review-decisions" data-oaam-source-control-layout="destination_and_ignore">
                                {destinationControl}
                                <button
                                    data-oaam-interaction-entry="features.discovery.discovery_source_review.008"
                                    type="button"
                                    className="source-ignore-button"
                                    data-oaam-source-action="ignore"
                                    data-oaam-project-decision={unregisteredProjectProposal === undefined ? undefined : "skip"}
                                    disabled={busy}
                                    onClick={() => setPendingIgnoreKey(group.key)}
                                >
                                    {text("discovery.product.source.ignore")}
                                </button>
                            </div>
                        ) : (
                            <small className="source-read-unavailable">{text("discovery.product.source.read_unavailable")}</small>
                        )}
                        {pendingIgnoreKey !== group.key ? null : (
                            <fieldset className="source-ignore-confirmation" data-oaam-source-ignore-confirmation="true">
                                <legend>{text("discovery.product.source.ignore_prompt")}</legend>
                                <small>{text("discovery.product.source.ignore_effect")}</small>
                                <span>
                                    <button
                                        data-oaam-interaction-entry="features.discovery.discovery_source_review.009"
                                        type="button"
                                        className="library-secondary-button"
                                        disabled={busy}
                                        onClick={() => setPendingIgnoreKey(undefined)}
                                    >
                                        {text("discovery.product.source.ignore_cancel")}
                                    </button>
                                    <button
                                        data-oaam-interaction-entry="features.discovery.discovery_source_review.010"
                                        type="button"
                                        className="source-ignore-confirm-button"
                                        data-oaam-source-action="confirm-ignore"
                                        disabled={busy}
                                        onClick={() => void ignoreGroup()}
                                    >
                                        {text("discovery.product.source.ignore_confirm")}
                                    </button>
                                </span>
                            </fieldset>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
