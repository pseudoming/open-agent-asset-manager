import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ObservedProjectRootAuthorizationResult } from "../../../bridge/desktop-bridge";
import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { DesktopIcon, StatusPanel, WorkbenchNotice, WorkbenchPanel } from "../../ui";
import { ProjectLifecycleDialog, type ProjectLifecycleProject, type ProjectLifecycleReviewContext } from "../project-library";
import { countIncludedSourceLocations } from "../source-library";
import { DiscoveryEnvironmentReferenceNotices } from "./DiscoveryEnvironmentReferenceNotices";
import { DiscoveryProjectRegistrationDialog } from "./DiscoveryProjectRegistrationDialog";
import { DiscoveryResults, DiscoverySourceFeedback } from "./DiscoveryResults";
import { DiscoverySettingsLocationsPanel } from "./DiscoverySettingsLocationsPanel";
import { DiscoveryEnvironmentChoices, DiscoveryToolChoices } from "./DiscoverySetupChoices";
import { DiscoverySourceReview } from "./DiscoverySourceReview";
import { useDiscoverySourceSelection } from "./use-discovery-source-selection";
import type { DiscoveryState } from "./discovery-controller";
import { discoverySourceGroupBelongsToRegisteredProject } from "./discovery-project-source-scope";
import {
    buildReadSourceRequest,
    type DiscoveryWatchSelection,
    defaultDiscoveryWatchSelections,
    deriveDiscoveryEnvironmentProbeOutcomes,
    deriveDiscoveryProjectProposals,
    discoveryProjectProposalForSourceGroup,
    discoveryProviderContextReceipts,
    groupDiscoverySourceClaims,
    persistedDiscoveryWatchSelections,
    projectDiscoverySourcesForProbe,
    reconcileDiscoveryWatchSelectionsForRegisteredProject,
} from "./discovery-model";
import {
    DISCOVERY_JOURNEY_STAGE_MESSAGES,
    type DiscoveryWorkspaceProps,
    discoveryEnvironmentIdentity,
    discoveryEnvironmentKey,
    discoveryWatchSelectionFingerprint,
    isSoleLocalDiscoveryEnvironment,
    prepareDiscoveryImportReview,
    unresolvedDiscoveryProjectProposals,
} from "./discovery-workspace-model";
import { useDiscoveryScopedProbe } from "./use-discovery-scoped-probe";
import "./discovery.css";

const EMPTY_DISCOVERY_SOURCES = Object.freeze([]);
const EMPTY_DISCOVERY_PROJECTS = Object.freeze([]);
export function DiscoveryWorkspace({
    controller,
    client,
    targetProjectId,
    preferredProjectId,
    journey,
    authorizeObservedProjectRoot,
    revealObservedProjectRoot,
    authorizeRegisteredProjectRoot,
    onReviewSources,
    onStateChange,
}: DiscoveryWorkspaceProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const [state, setState] = useState<DiscoveryState>(controller.state);
    const [watchSelection, setWatchSelection] = useState<{
        readonly identity: string;
        readonly selections: readonly DiscoveryWatchSelection[];
    }>({ identity: "", selections: [] });
    const [projectDecisions, setProjectDecisions] = useState<{
        readonly identity: string;
        readonly decisions: ReadonlyMap<string, "added" | "skipped">;
        readonly pendingKey: string | undefined;
        readonly errorKey: string | undefined;
        readonly errorMessage: string | undefined;
        readonly errorDiagnostics: readonly ProtocolDiagnosticV1[];
    }>({
        identity: "",
        decisions: new Map(),
        pendingKey: undefined,
        errorKey: undefined,
        errorMessage: undefined,
        errorDiagnostics: [],
    });
    const [probeCompletion, setProbeCompletion] = useState<{ readonly probeToken: string; readonly completedAt: number }>();
    const { probeCurrentScope, projectProbeAuthorizationPending, registeredProjectAccessFailed } = useDiscoveryScopedProbe({
        controller,
        targetProjectId,
        preferredProjectId,
        authorizeRegisteredProjectRoot,
    });
    const [projectRegistration, setProjectRegistration] = useState<{
        readonly identity: string;
        readonly projectKey: string;
    }>();
    const [projectRestore, setProjectRestore] = useState<{
        readonly identity: string;
        readonly projectKey: string;
        readonly project: Extract<DiscoveryState, { readonly status: "ready" }>["retainedProjects"][number];
    }>();
    const autoAdvancedSoleLocation = useRef(false);
    const lastPersistedWatchSelectionFingerprint = useRef<string | undefined>(undefined);
    useEffect(() => {
        const unsubscribe = controller.subscribe((next) => {
            setState(next);
            onStateChange?.(next);
        });
        void controller.load();
        return unsubscribe;
    }, [controller, onStateChange]);
    useEffect(() => {
        if (journey?.stage === "locations" && !autoAdvancedSoleLocation.current && isSoleLocalDiscoveryEnvironment(state)) {
            autoAdvancedSoleLocation.current = true;
            journey.onStageChange("tools");
        }
    }, [journey, state]);
    const probeToken = state.status === "ready" ? state.probeReview?.probeToken : undefined;
    useEffect(() => {
        if (probeToken === undefined || probeCompletion?.probeToken === probeToken) return;
        setProbeCompletion({ probeToken, completedAt: Date.now() });
    }, [probeCompletion?.probeToken, probeToken]);
    const watchIdentity =
        state.status === "ready" && probeToken !== undefined ? `${probeToken}\0${state.watched.settingFingerprint}` : "";
    const readySources = state.status === "ready" ? state.sources : EMPTY_DISCOVERY_SOURCES;
    const readyProjects = state.status === "ready" ? state.projects : EMPTY_DISCOVERY_PROJECTS;
    const readyRetainedProjects = state.status === "ready" ? state.retainedProjects : EMPTY_DISCOVERY_PROJECTS;
    const readyProbeReview = state.status === "ready" ? state.probeReview : undefined;
    const targetProject = readyProjects.find(
        (project) => targetProjectId !== undefined && !project.deleted && project.projectId === targetProjectId,
    );
    const probeVisibleSources =
        journey !== undefined && readyProbeReview !== undefined
            ? projectDiscoverySourcesForProbe(readySources, readyProbeReview)
            : readySources;
    const discoveredProjects =
        state.status === "ready" && readyProbeReview !== undefined
            ? deriveDiscoveryProjectProposals(readyProbeReview, [...state.projects, ...state.retainedProjects])
            : [];
    const allSourceClaimGroups =
        readyProbeReview !== undefined ? groupDiscoverySourceClaims(probeVisibleSources, readyProbeReview) : [];
    const sourceClaimGroups =
        targetProjectId === undefined
            ? allSourceClaimGroups
            : targetProject !== undefined && readyProbeReview !== undefined
              ? allSourceClaimGroups.filter((group) =>
                    discoverySourceGroupBelongsToRegisteredProject(group, readyProbeReview, targetProject),
                )
              : [];
    const { selectedSourceKeys, onSelectedSourceKeysChange, ...runtimeSelection } = useDiscoverySourceSelection(
        probeToken,
        sourceClaimGroups,
    );
    const visibleSourceKeys = new Set(sourceClaimGroups.flatMap((group) => group.claims.map((claim) => claim.source.key)));
    const visibleSourceKeyFingerprint = JSON.stringify([...visibleSourceKeys].sort());
    const visibleSources =
        targetProjectId === undefined
            ? probeVisibleSources
            : probeVisibleSources.filter((source) => visibleSourceKeys.has(source.key));
    const reviewableDiscoveredProjects =
        targetProjectId === undefined
            ? discoveredProjects
            : discoveredProjects.filter((project) => project.matchedProjectId === targetProjectId);
    const projectDecisionIdentity =
        state.status === "ready" && state.probeReview !== undefined
            ? `${state.probeReview.probeToken}\0${reviewableDiscoveredProjects.map((project) => project.key).join("\0")}`
            : "";
    const setCurrentProjectDecisions = useCallback(
        (update: (current: typeof projectDecisions) => typeof projectDecisions): void => {
            setProjectDecisions((current) =>
                update(
                    current.identity === projectDecisionIdentity
                        ? current
                        : {
                              identity: projectDecisionIdentity,
                              decisions: new Map(),
                              pendingKey: undefined,
                              errorKey: undefined,
                              errorMessage: undefined,
                              errorDiagnostics: [],
                          },
                ),
            );
        },
        [projectDecisionIdentity],
    );
    const currentProjectDecisions =
        projectDecisions.identity === projectDecisionIdentity
            ? projectDecisions.decisions
            : new Map<string, "added" | "skipped">();
    const currentProjectPendingKey =
        projectDecisions.identity === projectDecisionIdentity ? projectDecisions.pendingKey : undefined;
    const currentProjectErrorKey = projectDecisions.identity === projectDecisionIdentity ? projectDecisions.errorKey : undefined;
    const currentProjectErrorMessage =
        projectDecisions.identity === projectDecisionIdentity ? projectDecisions.errorMessage : undefined;
    const currentProjectErrorDiagnostics =
        projectDecisions.identity === projectDecisionIdentity ? projectDecisions.errorDiagnostics : [];
    const projectRegistrationProposal =
        projectRegistration?.identity === projectDecisionIdentity
            ? reviewableDiscoveredProjects.find((project) => project.key === projectRegistration.projectKey)
            : undefined;
    useEffect(() => {
        if (state.status !== "ready" || watchIdentity === "") return;
        const currentVisibleSourceKeys = new Set(JSON.parse(visibleSourceKeyFingerprint) as string[]);
        setWatchSelection((current) =>
            current.identity === watchIdentity
                ? current
                : {
                      identity: watchIdentity,
                      selections: defaultDiscoveryWatchSelections(readySources, readyProjects).filter((selection) => {
                          if (targetProjectId === undefined || currentVisibleSourceKeys.has(selection.sourceKey)) return true;
                          const source = readySources.find((candidate) => candidate.key === selection.sourceKey);
                          return (
                              source?.watchAvailability.status === "selectable" &&
                              source.watchAvailability.prior?.disposition === "included"
                          );
                      }),
                  },
        );
    }, [readyProjects, readySources, state.status, targetProjectId, visibleSourceKeyFingerprint, watchIdentity]);
    useEffect(() => {
        if (projectDecisionIdentity === "" || projectDecisions.identity === projectDecisionIdentity) return;
        setCurrentProjectDecisions((current) => current);
    }, [projectDecisionIdentity, projectDecisions.identity, setCurrentProjectDecisions]);

    if (state.status === "loading") {
        return (
            <StatusPanel
                eyebrow={text("discovery.ui.eyebrow")}
                title={text("discovery.ui.loading_providers")}
                message={displayText(state.message)}
                busy
            />
        );
    }
    if (state.status === "failed") {
        return (
            <StatusPanel
                eyebrow={text("discovery.ui.eyebrow")}
                title={text("discovery.settings_unavailable")}
                message={displayText(state.message)}
                tone="danger"
            >
                <ProtocolDiagnostics diagnostics={state.diagnostics} />
                <button
                    data-oaam-interaction-entry="features.discovery.discovery_workspace.001"
                    type="button"
                    onClick={() => void controller.load()}
                >
                    {text("common.retry")}
                </button>
            </StatusPanel>
        );
    }
    if (targetProjectId !== undefined && targetProject === undefined) {
        return (
            <StatusPanel
                eyebrow={text("guided_import.eyebrow")}
                title={text("guided_import.project_missing_title")}
                message={text("guided_import.project_missing_copy")}
                tone="neutral"
            />
        );
    }

    const busy =
        state.activity === "saving" ||
        state.activity === "probing" ||
        state.activity === "saving_watch" ||
        projectProbeAuthorizationPending ||
        journey?.readOnly === true;
    const unsaved = controller.hasUnsavedProviderChanges();
    const watchedCount = countIncludedSourceLocations(state.watched);
    const selectedEnvironmentKeys = new Set(state.selectedEnvironmentKeys);
    const selectedEnvironmentIdentities = state.environments
        .filter((environment) => selectedEnvironmentKeys.has(discoveryEnvironmentKey(environment.environment)))
        .map((environment) => discoveryEnvironmentIdentity(environment.environment));
    const probedEnvironmentIdentities = [
        ...new Set((state.probeReview?.results ?? []).map((result) => discoveryEnvironmentIdentity(result.environment))),
    ].sort();
    const probedSourcePaths = [...new Set(visibleSources.map((source) => source.displayPath))].sort();
    const environmentProbeOutcomes =
        state.probeReview === undefined ? [] : deriveDiscoveryEnvironmentProbeOutcomes(state.probeReview);
    const providerContextReceipts = discoveryProviderContextReceipts(environmentProbeOutcomes);
    const environmentReferenceNotices = (
        <DiscoveryEnvironmentReferenceNotices
            providers={state.providers}
            references={state.environmentReferences}
            disabled={busy}
            onChooseEnvironments={journey === undefined ? undefined : () => journey.onStageChange("locations")}
        />
    );
    const hasAttributedProbeIssues = environmentProbeOutcomes.some((outcome) =>
        outcome.tools.some((tool) => tool.diagnostics.length > 0),
    );
    const sourceProjectProposalKeys = new Set(
        sourceClaimGroups.flatMap((group) => {
            const proposal = discoveryProjectProposalForSourceGroup(group, discoveredProjects);
            return proposal === undefined ? [] : [proposal.key];
        }),
    );
    const detachedProjectProposals =
        targetProjectId === undefined
            ? reviewableDiscoveredProjects.filter(
                  (project) => project.rootPath !== undefined && !sourceProjectProposalKeys.has(project.key),
              )
            : [];
    const draftWatchSelections =
        watchSelection.identity === watchIdentity
            ? watchSelection.selections
            : state.status === "ready"
              ? defaultDiscoveryWatchSelections(readySources, readyProjects)
              : [];
    const watchSelections = draftWatchSelections;
    const persistedWatchSelections = persistedDiscoveryWatchSelections(readySources);
    const hasUnsavedWatchSelections =
        discoveryWatchSelectionFingerprint(watchSelections) !== discoveryWatchSelectionFingerprint(persistedWatchSelections);
    const unresolvedProjects = unresolvedDiscoveryProjectProposals(
        sourceClaimGroups,
        reviewableDiscoveredProjects,
        selectedSourceKeys,
        watchSelections,
        readyProjects,
        currentProjectDecisions,
    );
    const currentProbeCompletedAt =
        probeCompletion !== undefined && probeCompletion.probeToken === state.probeReview?.probeToken
            ? probeCompletion.completedAt
            : undefined;
    const readRequest =
        state.probeReview === undefined
            ? undefined
            : buildReadSourceRequest(
                  state.probeReview,
                  visibleSources,
                  new Set(selectedSourceKeys),
                  runtimeSelection.readAgentRuntimeIdsBySource,
              );
    const reviewPreparation =
        readRequest === undefined || state.probeReview === undefined
            ? undefined
            : prepareDiscoveryImportReview(readRequest, state.probeReview, state.providers);

    const environmentChoices = <DiscoveryEnvironmentChoices busy={busy} controller={controller} state={state} />;
    const toolChoices = <DiscoveryToolChoices busy={busy} controller={controller} state={state} />;

    const results = (
        <>
            {registeredProjectAccessFailed ? (
                <WorkbenchNotice tone="danger" role="alert" data-oaam-project-probe-authorization="failed">
                    {text("catalog.ui.target.picker_failed")}
                </WorkbenchNotice>
            ) : null}
            {state.activity === "probe_failed" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    <p>{state.message === undefined ? "" : displayText(state.message)}</p>
                    <button
                        data-oaam-interaction-entry="features.discovery.discovery_workspace.002"
                        type="button"
                        onClick={() => void probeCurrentScope()}
                    >
                        {text("discovery.ui.retry_discovery")}
                    </button>
                </WorkbenchNotice>
            ) : null}
            <DiscoveryResults
                completedAt={currentProbeCompletedAt}
                outcomes={environmentProbeOutcomes}
                providers={state.providers}
                sourceCount={sourceClaimGroups.length}
                showEnvironmentDetails={journey !== undefined}
            />
            {environmentReferenceNotices}
            {state.probeReview === undefined ? (
                <WorkbenchNotice tone="empty">{text("discovery.ui.no_snapshot")}</WorkbenchNotice>
            ) : sourceClaimGroups.length === 0 ? (
                <WorkbenchNotice tone="empty">{text("discovery.ui.no_sources")}</WorkbenchNotice>
            ) : null}
            {state.activity === "probe_failed" ? <ProtocolDiagnostics diagnostics={state.activityDiagnostics} /> : null}
        </>
    );

    const sourceEmptyState =
        state.probeReview === undefined ? (
            <WorkbenchNotice tone="empty">{text("discovery.ui.no_snapshot")}</WorkbenchNotice>
        ) : sourceClaimGroups.length === 0 ? (
            <WorkbenchNotice tone="empty">{text("discovery.ui.no_sources")}</WorkbenchNotice>
        ) : null;
    const sourceReview =
        sourceClaimGroups.length === 0 ? null : (
            <DiscoverySourceReview
                key={state.probeReview?.probeToken ?? "no-probe"}
                busy={busy}
                groups={sourceClaimGroups}
                purpose={journey === undefined ? "manage_locations" : "import"}
                projectDecisions={currentProjectDecisions}
                projectErrorKey={
                    projectRegistration?.identity === projectDecisionIdentity &&
                    projectRegistration.projectKey === currentProjectErrorKey
                        ? undefined
                        : currentProjectErrorKey
                }
                projectErrorMessage={currentProjectErrorMessage}
                projectErrorDiagnostics={currentProjectErrorDiagnostics}
                projectPendingKey={currentProjectPendingKey}
                projectProposals={journey === undefined || journey.stage === "sources" ? reviewableDiscoveredProjects : []}
                projects={readyProjects}
                providers={state.providers}
                selectedSourceKeys={selectedSourceKeys}
                {...runtimeSelection}
                watchSelections={watchSelections}
                onSelectedSourceKeysChange={
                    onReviewSources === undefined && journey === undefined ? undefined : onSelectedSourceKeysChange
                }
                onAddProjectProposal={
                    authorizeObservedProjectRoot === undefined || revealObservedProjectRoot === undefined
                        ? undefined
                        : openProjectRegistration
                }
                onProjectProposalSkippedChange={setProjectProposalSkipped}
                onWatchSelectionsChange={(selections) =>
                    setWatchSelection({
                        identity: watchIdentity,
                        selections,
                    })
                }
                onPersistWatchSelections={persistWatchSelections}
            />
        );

    async function persistWatchSelections(
        selections: readonly DiscoveryWatchSelection[],
        explicitlyExcludedSourceKeys: readonly string[] = [],
    ): Promise<boolean> {
        const persisted = await controller.saveWatchedSources(selections, explicitlyExcludedSourceKeys);
        if (persisted) lastPersistedWatchSelectionFingerprint.current = discoveryWatchSelectionFingerprint(selections);
        return persisted;
    }

    function routeAfterJourneyProbe(): void {
        const readyState = controller.state;
        if (
            journey === undefined ||
            readyState.status !== "ready" ||
            readyState.probeReview === undefined ||
            readyState.activity === "probe_failed"
        ) {
            return;
        }
        const probeReview = readyState.probeReview;
        const groups = groupDiscoverySourceClaims(projectDiscoverySourcesForProbe(readyState.sources, probeReview), probeReview);
        const scopedProject =
            targetProjectId === undefined
                ? undefined
                : readyState.projects.find((project) => !project.deleted && project.projectId === targetProjectId);
        const visibleGroups =
            targetProjectId === undefined
                ? groups
                : scopedProject === undefined
                  ? []
                  : groups.filter((group) => discoverySourceGroupBelongsToRegisteredProject(group, probeReview, scopedProject));
        if (visibleGroups.length > 0) {
            journey.onStageChange("sources");
            return;
        }
        if (readyState.environmentReferences.length > 0) return;
        if (targetProjectId !== undefined || readyState.activityDiagnostics.length === 0)
            journey.onNoContentFound("no_sources_found");
    }

    async function runJourneyProbe(): Promise<void> {
        if (await probeCurrentScope()) routeAfterJourneyProbe();
    }

    async function runSettingsProbe(): Promise<void> {
        if (!(await controller.saveProviderEnablement())) return;
        await probeCurrentScope();
    }

    async function continueFromTools(): Promise<void> {
        if (journey === undefined || !(await controller.saveProviderEnablement())) return;
        journey.onStageChange("results");
        await runJourneyProbe();
    }

    async function continueFromSources(): Promise<void> {
        if (unresolvedProjects.length > 0) return;
        if (journey === undefined) return;
        const fingerprint = discoveryWatchSelectionFingerprint(watchSelections);
        if (lastPersistedWatchSelectionFingerprint.current !== fingerprint && !(await persistWatchSelections(watchSelections))) {
            return;
        }
        if (reviewPreparation === undefined) journey.onNoContentFound("no_sources_selected");
        else journey.onReviewAssets(reviewPreparation);
    }

    function openProjectRegistration(project: (typeof discoveredProjects)[number]): void {
        const retainedProject =
            project.matchedRetainedProjectId === undefined
                ? undefined
                : readyRetainedProjects.find((candidate) => candidate.projectId === project.matchedRetainedProjectId);
        if (retainedProject !== undefined) {
            if (
                client === undefined ||
                !client.supportsOperation("project_lifecycle.inspect") ||
                !client.supportsOperation("project_lifecycle.commit") ||
                currentProjectPendingKey !== undefined
            ) {
                return;
            }
            setCurrentProjectDecisions((current) => ({
                ...current,
                errorKey: undefined,
                errorMessage: undefined,
                errorDiagnostics: [],
            }));
            setProjectRestore({
                identity: projectDecisionIdentity,
                projectKey: project.key,
                project: retainedProject,
            });
            return;
        }
        if (
            authorizeObservedProjectRoot === undefined ||
            revealObservedProjectRoot === undefined ||
            project.rootPath === undefined ||
            project.registrationReference === undefined ||
            currentProjectPendingKey !== undefined
        ) {
            return;
        }
        setCurrentProjectDecisions((current) => ({
            ...current,
            errorKey: undefined,
            errorMessage: undefined,
            errorDiagnostics: [],
        }));
        setProjectRegistration({ identity: projectDecisionIdentity, projectKey: project.key });
    }

    function completeDiscoveredProjectRestore(
        restoredProject: ProjectLifecycleProject,
        context: ProjectLifecycleReviewContext,
    ): void {
        const request = projectRestore;
        if (
            request === undefined ||
            request.identity !== projectDecisionIdentity ||
            context.review.action !== "restore" ||
            !controller.applyRestoredProject(restoredProject, request.project.projectId, request.project.rootPath)
        ) {
            if (request !== undefined) {
                setCurrentProjectDecisions((current) => ({
                    ...current,
                    errorKey: request.projectKey,
                    errorMessage: text("import_journey.projects.restore_failed"),
                    errorDiagnostics: [],
                }));
            }
            setProjectRestore(undefined);
            return;
        }
        const sourceGroup = sourceClaimGroups.find(
            (group) => discoveryProjectProposalForSourceGroup(group, discoveredProjects)?.key === request.projectKey,
        );
        const reboundWatchSelections = reconcileDiscoveryWatchSelectionsForRegisteredProject(
            sourceClaimGroups,
            journey === undefined && sourceGroup !== undefined
                ? [...selectedSourceKeys, ...sourceGroup.reviewSourceKeys]
                : selectedSourceKeys,
            watchSelections,
            readyProjects,
            restoredProject,
        );
        if (reboundWatchSelections !== watchSelections) {
            setWatchSelection({ identity: watchIdentity, selections: reboundWatchSelections });
            if (journey === undefined) void persistWatchSelections(reboundWatchSelections);
        }
        setCurrentProjectDecisions((current) => {
            const decisions = new Map(current.decisions);
            decisions.set(request.projectKey, "added");
            return {
                ...current,
                decisions,
                pendingKey: undefined,
                errorKey: undefined,
                errorMessage: undefined,
                errorDiagnostics: [],
            };
        });
        setProjectRestore(undefined);
    }

    async function addDiscoveredProject(project: (typeof discoveredProjects)[number], displayName: string): Promise<void> {
        if (
            authorizeObservedProjectRoot === undefined ||
            project.rootPath === undefined ||
            project.registrationReference === undefined ||
            currentProjectPendingKey !== undefined
        ) {
            return;
        }
        const expectedRootPath = project.rootPath;
        setCurrentProjectDecisions((current) => ({
            ...current,
            pendingKey: project.key,
            errorKey: undefined,
            errorMessage: undefined,
            errorDiagnostics: [],
        }));
        let selection: ObservedProjectRootAuthorizationResult;
        try {
            selection = await authorizeObservedProjectRoot(project.registrationReference);
        } catch {
            selection = { status: "failed", code: "unavailable" };
        }
        if (selection.status === "failed" || selection.displayPath !== expectedRootPath) {
            setCurrentProjectDecisions((current) => ({
                ...current,
                pendingKey: undefined,
                errorKey: project.key,
                errorMessage: text("import_journey.projects.observation_unavailable"),
                errorDiagnostics: [],
            }));
            return;
        }
        const result = await controller.registerProject(selection.localPathSelectionToken, displayName);
        if (result.status === "failed" || result.project.rootPath !== expectedRootPath) {
            setCurrentProjectDecisions((current) => ({
                ...current,
                pendingKey: undefined,
                errorKey: project.key,
                errorMessage: text("import_journey.projects.add_failed"),
                errorDiagnostics: result.status === "failed" ? result.diagnostics : [],
            }));
            return;
        }
        const sourceGroup = sourceClaimGroups.find(
            (group) => discoveryProjectProposalForSourceGroup(group, discoveredProjects)?.key === project.key,
        );
        const reboundWatchSelections = reconcileDiscoveryWatchSelectionsForRegisteredProject(
            sourceClaimGroups,
            journey === undefined && sourceGroup !== undefined
                ? [...selectedSourceKeys, ...sourceGroup.reviewSourceKeys]
                : selectedSourceKeys,
            watchSelections,
            readyProjects,
            result.project,
        );
        if (reboundWatchSelections !== watchSelections) {
            setWatchSelection({
                identity: watchIdentity,
                selections: reboundWatchSelections,
            });
            if (journey === undefined) await persistWatchSelections(reboundWatchSelections);
        }
        setCurrentProjectDecisions((current) => {
            const decisions = new Map(current.decisions);
            decisions.set(project.key, "added");
            return {
                ...current,
                decisions,
                pendingKey: undefined,
                errorKey: undefined,
                errorMessage: undefined,
                errorDiagnostics: [],
            };
        });
        setProjectRegistration(undefined);
    }

    function setProjectProposalSkipped(project: (typeof discoveredProjects)[number], skipped: boolean): void {
        setCurrentProjectDecisions((current) => {
            const decisions = new Map(current.decisions);
            if (skipped) decisions.set(project.key, "skipped");
            else if (decisions.get(project.key) === "skipped") decisions.delete(project.key);
            return {
                ...current,
                decisions,
                errorKey: current.errorKey === project.key ? undefined : current.errorKey,
                errorMessage: current.errorKey === project.key ? undefined : current.errorMessage,
                errorDiagnostics: current.errorKey === project.key ? [] : current.errorDiagnostics,
            };
        });
    }

    const projectReview =
        journey?.stage !== "sources" || detachedProjectProposals.length === 0 ? null : (
            <section className="discovery-project-review" aria-labelledby="discovery-project-review-title">
                <div>
                    <h3 id="discovery-project-review-title">{text("import_journey.projects.title")}</h3>
                    <p>{text("import_journey.projects.copy")}</p>
                </div>
                <ul>
                    {detachedProjectProposals.map((project) => {
                        const decision = currentProjectDecisions.get(project.key);
                        const matched = project.matchedProjectId !== undefined || decision === "added";
                        return (
                            <li
                                data-oaam-project-adapter-ids={JSON.stringify(project.adapterIds)}
                                data-oaam-project-proposal-key={project.key}
                                key={project.key}
                            >
                                <span>
                                    <strong>{project.displayName}</strong>
                                    {project.rootPath === undefined ? null : <code>{project.rootPath}</code>}
                                </span>
                                {matched ? (
                                    <small>{text("import_journey.projects.matched")}</small>
                                ) : decision === "skipped" ? (
                                    <small>{text("import_journey.projects.skipped")}</small>
                                ) : (
                                    <span className="discovery-project-actions">
                                        <button
                                            data-oaam-interaction-entry="features.discovery.discovery_workspace.003"
                                            type="button"
                                            data-oaam-project-decision="add"
                                            data-oaam-project-lifecycle-action={
                                                project.matchedRetainedProjectId === undefined ? undefined : "restore"
                                            }
                                            disabled={
                                                currentProjectPendingKey !== undefined ||
                                                (project.matchedRetainedProjectId === undefined &&
                                                    project.registrationReference === undefined) ||
                                                authorizeObservedProjectRoot === undefined ||
                                                revealObservedProjectRoot === undefined
                                            }
                                            onClick={() => openProjectRegistration(project)}
                                        >
                                            {text(
                                                currentProjectPendingKey === project.key
                                                    ? project.matchedRetainedProjectId === undefined
                                                        ? "import_journey.projects.adding"
                                                        : "import_journey.projects.restoring"
                                                    : project.matchedRetainedProjectId === undefined
                                                      ? "import_journey.projects.add"
                                                      : "import_journey.projects.restore",
                                            )}
                                        </button>
                                        <button
                                            data-oaam-interaction-entry="features.discovery.discovery_workspace.004"
                                            type="button"
                                            className="library-secondary-button"
                                            data-oaam-project-decision="skip"
                                            disabled={currentProjectPendingKey !== undefined}
                                            onClick={() => setProjectProposalSkipped(project, true)}
                                        >
                                            {text("import_journey.projects.not_now")}
                                        </button>
                                    </span>
                                )}
                                {currentProjectErrorKey === project.key ? (
                                    currentProjectErrorDiagnostics.length > 0 ? (
                                        <div role="alert">
                                            <ProtocolDiagnostics diagnostics={currentProjectErrorDiagnostics} layout="grouped" />
                                        </div>
                                    ) : (
                                        <WorkbenchNotice tone="danger" role="alert">
                                            {currentProjectErrorMessage}
                                        </WorkbenchNotice>
                                    )
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            </section>
        );

    const journeyPanel =
        journey === undefined ? null : (
            <WorkbenchPanel aria-labelledby={`import-journey-${journey.stage}-title`}>
                <div className="section-heading">
                    <div>
                        <h2 id={`import-journey-${journey.stage}-title`}>
                            {text(DISCOVERY_JOURNEY_STAGE_MESSAGES[journey.stage].title)}
                        </h2>
                    </div>
                    {journey.stage === "results" && state.activity !== "probing" ? (
                        <button
                            data-oaam-interaction-entry="features.discovery.discovery_workspace.005"
                            type="button"
                            className="library-secondary-button"
                            disabled={busy}
                            onClick={() => void runJourneyProbe()}
                        >
                            {text("import_journey.results.refresh")}
                        </button>
                    ) : null}
                </div>
                <p className="section-copy">{text(DISCOVERY_JOURNEY_STAGE_MESSAGES[journey.stage].copy)}</p>
                {journey.stage === "locations" ? environmentChoices : null}
                {journey.stage === "tools" ? toolChoices : null}
                {journey.stage === "results" ? (
                    state.activity === "probing" ? (
                        <WorkbenchNotice className="discovery-probe-progress" role="status" aria-busy="true">
                            <span className="status-card-spinner" data-oaam-loading-indicator>
                                <DesktopIcon name="loading" size={17} />
                            </span>
                            <span>{text("discovery.ui.scanning")}</span>
                        </WorkbenchNotice>
                    ) : (
                        results
                    )
                ) : null}
                {journey.stage === "sources" ? (
                    <>
                        <DiscoveryResults
                            completedAt={currentProbeCompletedAt}
                            outcomes={environmentProbeOutcomes}
                            providers={state.providers}
                            sourceCount={sourceClaimGroups.length}
                            showEnvironmentDetails={false}
                        />
                        {environmentReferenceNotices}
                        {sourceEmptyState ?? sourceReview}
                        {projectReview}
                        <DiscoverySourceFeedback
                            activity={state.activity}
                            message={state.message}
                            hasAttributedProbeIssues={hasAttributedProbeIssues}
                        />
                        {state.activity !== "idle" || !hasAttributedProbeIssues ? (
                            <ProtocolDiagnostics diagnostics={state.activityDiagnostics} layout="grouped" />
                        ) : null}
                    </>
                ) : null}
                {journey.readOnly === true ? null : (
                    <nav
                        className={
                            journey.stage === "sources" ? "onboarding-actions onboarding-actions-with-copy" : "onboarding-actions"
                        }
                        aria-label={journey.navigationLabel}
                    >
                        {journey.stage === "sources" ? (
                            <small className="onboarding-action-copy" data-oaam-watch-persistence-explanation>
                                {text("import_journey.sources.persistence")}
                            </small>
                        ) : null}
                        <button
                            type="button"
                            className="library-secondary-button"
                            data-oaam-semantic-action="journey.go_back"
                            data-oaam-semantic-entry="journey.locations.back"
                            disabled={busy}
                            onClick={() => {
                                if (journey.stage === "locations") journey.onBackFromLocations();
                                else if (journey.stage === "tools") journey.onStageChange("locations");
                                else if (journey.stage === "results") journey.onStageChange("tools");
                                else journey.onStageChange("tools");
                            }}
                        >
                            {text("common.back")}
                        </button>
                        {journey.stage === "locations" ? (
                            <button
                                data-oaam-interaction-entry="features.discovery.discovery_workspace.007"
                                type="button"
                                data-oaam-journey-continue="locations"
                                disabled={busy || state.selectedEnvironmentKeys.length === 0}
                                onClick={() => journey.onStageChange("tools")}
                            >
                                {text("import_journey.action.continue")}
                            </button>
                        ) : null}
                        {journey.stage === "tools" ? (
                            <button
                                data-oaam-interaction-entry="features.discovery.discovery_workspace.008"
                                type="button"
                                data-oaam-journey-continue="tools"
                                disabled={busy || state.selectedAdapterIds.length === 0}
                                onClick={() => void continueFromTools()}
                            >
                                {text(
                                    state.activity === "saving" ? "discovery.product.tools.saving" : "import_journey.action.scan",
                                )}
                            </button>
                        ) : null}
                        {journey.stage === "sources" ? (
                            <button
                                data-oaam-interaction-entry="features.discovery.discovery_workspace.009"
                                type="button"
                                data-oaam-journey-continue="sources"
                                disabled={
                                    state.activity !== "idle" ||
                                    state.probeReview === undefined ||
                                    unresolvedProjects.length > 0 ||
                                    currentProjectPendingKey !== undefined
                                }
                                onClick={() => void continueFromSources()}
                            >
                                {text("import_journey.action.review_assets")}
                            </button>
                        ) : null}
                    </nav>
                )}
            </WorkbenchPanel>
        );

    return (
        <>
            <div
                className="discovery-workspace"
                data-oaam-discovery-activity={state.activity}
                data-oaam-enabled-adapter-ids={JSON.stringify(state.enablement.enabledAdapterIds)}
                data-oaam-probed-environments={JSON.stringify(probedEnvironmentIdentities)}
                data-oaam-provider-context-receipts={JSON.stringify(providerContextReceipts)}
                data-oaam-probed-source-paths={JSON.stringify(probedSourcePaths)}
                data-oaam-selected-environments={JSON.stringify(selectedEnvironmentIdentities)}
                data-oaam-environment-result-statuses={JSON.stringify(
                    environmentProbeOutcomes.map((outcome) => [
                        discoveryEnvironmentIdentity(outcome.environment),
                        outcome.status,
                    ]),
                )}
                data-oaam-unchecked-reference-count={state.environmentReferences.length}
                data-oaam-journey-stage={journey?.stage}
                data-oaam-target-project-id={targetProjectId}
            >
                {journeyPanel}
                {journey === undefined ? (
                    <>
                        <WorkbenchPanel aria-labelledby="provider-title">
                            <div className="section-heading">
                                <div>
                                    <p className="eyebrow">{text("discovery.settings.scope.eyebrow")}</p>
                                    <h2 id="provider-title">{text("discovery.settings.scope.title")}</h2>
                                </div>
                                <button
                                    data-oaam-interaction-entry="features.discovery.discovery_workspace.010"
                                    type="button"
                                    data-oaam-provider-save
                                    disabled={!unsaved || busy}
                                    onClick={() => void controller.saveProviderEnablement()}
                                >
                                    {text(
                                        state.activity === "saving"
                                            ? "discovery.product.tools.saving"
                                            : "discovery.product.tools.save",
                                    )}
                                </button>
                            </div>
                            <p className="section-copy">{text("discovery.settings.scope.copy")}</p>
                            {environmentChoices}
                            {toolChoices}
                        </WorkbenchPanel>

                        <DiscoverySettingsLocationsPanel
                            busy={busy}
                            controller={controller}
                            environmentProbeOutcomes={environmentProbeOutcomes}
                            hasUnsavedWatchSelections={hasUnsavedWatchSelections}
                            onReviewSources={onReviewSources}
                            onSaveProviderEnablementAndProbe={runSettingsProbe}
                            readRequest={readRequest}
                            results={results}
                            sourceReview={sourceReview}
                            state={state}
                            unsaved={unsaved}
                            watchSelections={watchSelections}
                            watchedCount={watchedCount}
                        />
                    </>
                ) : null}
            </div>
            {projectRegistrationProposal === undefined || revealObservedProjectRoot === undefined ? null : (
                <DiscoveryProjectRegistrationDialog
                    busy={currentProjectPendingKey === projectRegistrationProposal.key}
                    errorMessage={
                        currentProjectErrorKey === projectRegistrationProposal.key ? currentProjectErrorMessage : undefined
                    }
                    errorDiagnostics={
                        currentProjectErrorKey === projectRegistrationProposal.key ? currentProjectErrorDiagnostics : []
                    }
                    proposal={projectRegistrationProposal}
                    onClose={() => {
                        if (currentProjectPendingKey === undefined) setProjectRegistration(undefined);
                    }}
                    onRegister={(displayName) => void addDiscoveredProject(projectRegistrationProposal, displayName)}
                    onReveal={() => {
                        const reference = projectRegistrationProposal.registrationReference;
                        return reference === undefined
                            ? Promise.resolve({ status: "failed", code: "unavailable" })
                            : revealObservedProjectRoot(reference);
                    }}
                />
            )}
            {projectRestore === undefined || client === undefined ? null : (
                <ProjectLifecycleDialog
                    client={client}
                    project={projectRestore.project}
                    initialAction="restore"
                    pickProjectRoot={async () => ({ status: "cancelled" })}
                    onClose={() => setProjectRestore(undefined)}
                    onCommitted={completeDiscoveredProjectRestore}
                />
            )}
        </>
    );
}
