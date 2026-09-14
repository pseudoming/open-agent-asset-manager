import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import type {
    DesktopObservedProjectRootReference,
    ObservedProjectRootAuthorizationResult,
    ObservedProjectRootRevealResult,
    RegisteredProjectRootAuthorizationResult,
} from "../../../bridge/desktop-bridge";
export { desktopEnvironmentKey as discoveryEnvironmentKey } from "../../../desktop-environment-key";
import type { DesktopApplicationClientApi } from "../../client";
import type { DesktopMessageId } from "../../presentation";
import type { ImportReviewPreparation } from "../import-review";
import type { DiscoveryController, DiscoveryState } from "./discovery-controller";
import {
    discoveryProjectProposalForSourceGroup,
    discoverySourceGroupHasWatchDestination,
    type DiscoveryProjectProposal,
    type DiscoverySourceClaimGroup,
    type DiscoveryWatchSelection,
    type ProjectListView,
} from "./discovery-model";
import { presentDiscoveryEnvironment, presentDiscoveryPath, presentDiscoveryTool } from "./discovery-presentation";

export type DiscoveryJourneyStage = "locations" | "tools" | "results" | "sources";

export interface DiscoveryJourney {
    readonly stage: DiscoveryJourneyStage;
    readonly readOnly?: boolean;
    readonly navigationLabel: string;
    readonly onStageChange: (stage: DiscoveryJourneyStage) => void;
    readonly onBackFromLocations: () => void;
    readonly onNoContentFound: (reason: "no_sources_found" | "no_sources_selected") => void;
    readonly onReviewAssets: (preparation: ImportReviewPreparation) => void;
}

export interface DiscoveryWorkspaceProps {
    readonly controller: DiscoveryController;
    readonly client?: DesktopApplicationClientApi;
    readonly targetProjectId?: string;
    readonly preferredProjectId?: string;
    readonly journey?: DiscoveryJourney;
    readonly authorizeObservedProjectRoot?: (
        reference: DesktopObservedProjectRootReference,
    ) => Promise<ObservedProjectRootAuthorizationResult>;
    readonly revealObservedProjectRoot?: (
        reference: DesktopObservedProjectRootReference,
    ) => Promise<ObservedProjectRootRevealResult>;
    readonly authorizeRegisteredProjectRoot?: (projectId: string) => Promise<RegisteredProjectRootAuthorizationResult>;
    readonly onReviewSources?: (request: ProtocolOperationParams<"adapter.read">) => void;
    readonly onStateChange?: (state: DiscoveryState) => void;
}

export const DISCOVERY_JOURNEY_STAGE_MESSAGES = {
    locations: {
        eyebrow: "import_journey.locations.eyebrow",
        title: "import_journey.locations.title",
        copy: "import_journey.locations.copy",
    },
    tools: {
        eyebrow: "import_journey.tools.eyebrow",
        title: "import_journey.tools.title",
        copy: "import_journey.tools.copy",
    },
    results: {
        eyebrow: "import_journey.results.eyebrow",
        title: "import_journey.results.title",
        copy: "import_journey.results.copy",
    },
    sources: {
        eyebrow: "import_journey.sources.eyebrow",
        title: "import_journey.sources.review_title",
        copy: "import_journey.sources.review_copy",
    },
} as const;

export function discoveryEnvironmentIdentity(environment: {
    readonly platform: string;
    readonly platformInstanceId: string;
}): string {
    return JSON.stringify([environment.platform, environment.platformInstanceId]);
}

export function discoveryWatchSelectionFingerprint(selections: readonly DiscoveryWatchSelection[]): string {
    return JSON.stringify(
        [...selections]
            .map((selection) => [
                selection.sourceKey,
                selection.binding.assetScope,
                selection.binding.assetScope === "project" ? selection.binding.projectId : "",
            ])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
}

export function discoveryEnvironmentHintMessage(platform: string): DesktopMessageId {
    if (platform === "win32") return "discovery.ui.environment.windows_default";
    if (platform === "wsl") return "discovery.ui.environment.wsl_opt_in";
    return "discovery.ui.environment.current_process";
}

export function isSoleLocalDiscoveryEnvironment(state: DiscoveryState): boolean {
    if (state.status !== "ready" || state.environments.length !== 1) return false;
    const platform = state.environments[0]?.environment.platform;
    return platform === "darwin" || platform === "linux";
}

export function retainsPriorDiscoverySourceExclusion(
    group: DiscoverySourceClaimGroup,
    selectedSourceKeys: readonly string[],
    watchSelections: readonly DiscoveryWatchSelection[],
): boolean {
    const selectedKeySet = new Set(selectedSourceKeys);
    const selected =
        group.reviewSourceKeys.length > 0 && group.reviewSourceKeys.every((sourceKey) => selectedKeySet.has(sourceKey));
    const groupSourceKeys = new Set(group.claims.map((claim) => claim.source.key));
    const futureScanEnabled = watchSelections.some((selection) => groupSourceKeys.has(selection.sourceKey));
    const priorExcluded = group.claims.some(
        (claim) =>
            claim.source.watchAvailability.status === "selectable" &&
            claim.source.watchAvailability.prior?.disposition === "excluded",
    );
    return priorExcluded && !selected && !futureScanEnabled;
}

export function unresolvedDiscoveryProjectProposals(
    sourceClaimGroups: readonly DiscoverySourceClaimGroup[],
    discoveredProjects: readonly DiscoveryProjectProposal[],
    selectedSourceKeys: readonly string[],
    watchSelections: readonly DiscoveryWatchSelection[],
    readyProjects: ProjectListView["projects"],
    currentProjectDecisions: ReadonlyMap<string, "added" | "skipped">,
): readonly DiscoveryProjectProposal[] {
    const priorExcludedProjectProposalKeys = new Set(
        sourceClaimGroups.flatMap((group) => {
            const proposal = discoveryProjectProposalForSourceGroup(group, discoveredProjects);
            return proposal !== undefined && retainsPriorDiscoverySourceExclusion(group, selectedSourceKeys, watchSelections)
                ? [proposal.key]
                : [];
        }),
    );
    const projectProposalKeysWithChosenDestination = new Set(
        sourceClaimGroups.flatMap((group) => {
            const proposal = discoveryProjectProposalForSourceGroup(group, discoveredProjects);
            return proposal !== undefined && discoverySourceGroupHasWatchDestination(group, watchSelections, readyProjects)
                ? [proposal.key]
                : [];
        }),
    );
    return discoveredProjects.filter(
        (project) =>
            project.rootPath !== undefined &&
            project.matchedProjectId === undefined &&
            currentProjectDecisions.get(project.key) === undefined &&
            !projectProposalKeysWithChosenDestination.has(project.key) &&
            !priorExcludedProjectProposalKeys.has(project.key),
    );
}

export function prepareDiscoveryImportReview(
    request: ProtocolOperationParams<"adapter.read">,
    probe: NonNullable<Extract<DiscoveryState, { readonly status: "ready" }>["probeReview"]>,
    providers: Extract<DiscoveryState, { readonly status: "ready" }>["providers"],
): ImportReviewPreparation {
    const sources = request.selections.flatMap((selection) => {
        const result = probe.results.find((candidate) => candidate.rowId === selection.probeResultRowId);
        if (result === undefined) return [];
        return selection.sourceRootRowIds.flatMap((sourceRootRowId) => {
            const source = result.sources.find((candidate) => candidate.rowId === sourceRootRowId);
            return source === undefined
                ? []
                : [
                      Object.freeze({
                          probeResultRowId: result.rowId,
                          sourceRootRowId: source.rowId,
                          sourceRootId: source.sourceRootId,
                          adapterId: result.adapterId,
                          environmentLabel: presentDiscoveryEnvironment(result.environment),
                          toolLabel: presentDiscoveryTool(result.adapterId, providers).label,
                          displayPath: presentDiscoveryPath(source.displayPath, result.environment),
                      }),
                  ];
        });
    });
    return Object.freeze({ request, sources: Object.freeze(sources) });
}
