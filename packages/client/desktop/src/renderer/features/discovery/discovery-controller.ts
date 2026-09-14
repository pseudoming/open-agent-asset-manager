import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopDisplayText, localizedText } from "../../presentation";
import {
    type AdapterEnablementView,
    type AdapterProviderView,
    buildWatchedScanDecisions,
    classifyDiscoverySources,
    type DiscoverySourceView,
    type DiscoveryWatchSelection,
    type EnvironmentListView,
    type ProbeEnvironmentReferenceView,
    type ProbeReviewView,
    type ProjectListView,
    sameStringSet,
    type WatchedScanIntentView,
} from "./discovery-model";
import { clearEnvironmentReferenceReview, queryEnvironmentReferences } from "./discovery-environment-reference-query";
import {
    applyDiscoveryProbeProgress,
    type DiscoveryProbeProgress,
    initialDiscoveryProbeProgress,
} from "./discovery-probe-progress";
import {
    environmentMatchesProjectRoot,
    type ProjectEnvironmentConstraint,
    projectEnvironmentConstraint,
    targetProject,
} from "./discovery-project-environment";
import { type DiscoveryProbeScope, resolveDiscoveryProbeScope } from "./discovery-probe-scope";
import {
    persistTargetProbeAuthorization,
    providerSelectionChanged,
    targetProbeAuthorizationRequired,
} from "./target-probe-authorization";

const ALL_PLATFORMS = Object.freeze(["win32", "wsl", "darwin", "linux"] as const);

export type DiscoveryActivity = "idle" | "saving" | "save_failed" | "probing" | "probe_failed" | "saving_watch" | "watch_failed";

export type DiscoveryState =
    | { readonly status: "loading"; readonly message: DesktopDisplayText }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "ready";
          readonly providers: readonly AdapterProviderView[];
          readonly enablement: AdapterEnablementView;
          readonly selectedAdapterIds: readonly string[];
          readonly watched: WatchedScanIntentView;
          readonly environments: EnvironmentListView["environments"];
          readonly selectedEnvironmentKeys: readonly string[];
          readonly projects: ProjectListView["projects"];
          readonly retainedProjects: ProjectListView["projects"];
          readonly probeReview: ProbeReviewView | undefined;
          readonly environmentReferences: readonly ProbeEnvironmentReferenceView[];
          readonly sources: readonly DiscoverySourceView[];
          readonly activity: DiscoveryActivity;
          readonly message: DesktopDisplayText | undefined;
          readonly configurationDiagnostics: readonly ProtocolDiagnosticV1[];
          readonly activityDiagnostics: readonly ProtocolDiagnosticV1[];
          readonly probeProgress?: DiscoveryProbeProgress;
      };

function acceptsSelectionChange(state: DiscoveryState): state is Extract<DiscoveryState, { status: "ready" }> {
    return (
        state.status === "ready" &&
        state.activity !== "saving" &&
        state.activity !== "probing" &&
        state.activity !== "saving_watch"
    );
}

export interface DiscoveryControllerOptions {
    readonly createUserActionId: () => string;
    readonly autoProbeWatched?: boolean;
    readonly targetProjectId?: string;
    readonly purpose?: "source_discovery" | "target_discovery";
}

export type DiscoveryProjectRegistrationResult =
    | { readonly status: "complete"; readonly project: ProjectListView["projects"][number] }
    | { readonly status: "failed"; readonly diagnostics: readonly ProtocolDiagnosticV1[] };

type ProbeAuthorization =
    | { readonly scope: "global"; readonly installationRootSelectionToken?: string }
    | {
          readonly scope: "project";
          readonly localPathSelectionToken: string;
          readonly installationRootSelectionToken?: string;
      };

function operationDiagnostics(...diagnosticGroups: readonly (readonly ProtocolDiagnosticV1[])[]): ProtocolDiagnosticV1[] {
    return diagnosticGroups.flatMap((diagnostics) => diagnostics.filter((diagnostic) => diagnostic.severity !== "info"));
}

function initialEnvironmentKeys(
    environments: EnvironmentListView["environments"],
    constraint: ProjectEnvironmentConstraint,
): readonly string[] {
    if (constraint.kind === "exact") return constraint.selectableKeys;
    if (constraint.kind !== "unconstrained") return Object.freeze([]);
    const preferred = environments.find((environment) => environment.environment.platform === "win32") ?? environments[0];
    return Object.freeze(preferred === undefined ? [] : [desktopEnvironmentKey(preferred.environment)]);
}

function watchedProbeScope(state: Extract<DiscoveryState, { readonly status: "ready" }>): DiscoveryProbeScope | undefined {
    const enabledProviderIds = new Set(state.enablement.enabledAdapterIds);
    const availableProviderIds = new Set(state.providers.map((provider) => provider.adapterId));
    const reachableEnvironments = new Map(
        state.environments.map(
            (environment) => [desktopEnvironmentKey(environment.environment), environment.environment] as const,
        ),
    );
    const selectedEnvironmentKey = state.selectedEnvironmentKeys[0];
    if (selectedEnvironmentKey === undefined) return undefined;
    const watchedEnvironment = state.watched.environments.find(
        (environment) => desktopEnvironmentKey(environment.environment) === selectedEnvironmentKey,
    );
    const reachable = reachableEnvironments.get(selectedEnvironmentKey);
    if (watchedEnvironment === undefined || reachable === undefined) return undefined;
    const adapterIds = new Set<string>();
    for (const selector of watchedEnvironment.sourceSelectors) {
        const adapterId = selector.source.adapterId;
        if (!enabledProviderIds.has(adapterId) || !availableProviderIds.has(adapterId)) continue;
        adapterIds.add(adapterId);
    }
    const adapterIdList = [...adapterIds].sort();
    const firstAdapterId = adapterIdList[0];
    if (firstAdapterId === undefined) return undefined;
    return {
        adapterIds: [firstAdapterId, ...adapterIdList.slice(1)],
        environments: [reachable],
    };
}

export class DiscoveryController {
    readonly #client: DesktopApplicationClientApi;
    readonly #options: DiscoveryControllerOptions;
    readonly #listeners = new Set<(state: DiscoveryState) => void>();
    #state: DiscoveryState = Object.freeze({ status: "loading", message: localizedText("discovery.loading") });
    #generation = 0;

    public constructor(client: DesktopApplicationClientApi, options: DiscoveryControllerOptions) {
        this.#client = client;
        this.#options = options;
    }

    public get state(): DiscoveryState {
        return this.#state;
    }

    public get projectEnvironmentConstrained(): boolean {
        return this.#options.targetProjectId !== undefined;
    }

    public get projectEnvironmentNeedsChoice(): boolean {
        if (this.#state.status !== "ready") return false;
        return (
            projectEnvironmentConstraint(
                this.#options.targetProjectId,
                this.#state.projects,
                this.#state.watched,
                this.#state.environments,
            ).kind === "choose"
        );
    }

    public isEnvironmentSelectable(key: string): boolean {
        if (this.#state.status !== "ready") return false;
        const constraint = projectEnvironmentConstraint(
            this.#options.targetProjectId,
            this.#state.projects,
            this.#state.watched,
            this.#state.environments,
        );
        if (constraint.kind === "unconstrained") {
            return this.#state.environments.some((candidate) => desktopEnvironmentKey(candidate.environment) === key);
        }
        return constraint.selectableKeys.includes(key);
    }

    public projectMatchesCurrentSelection(projectId: string): boolean {
        const state = this.#state;
        if (state.status !== "ready" || state.selectedEnvironmentKeys.length !== 1) return false;
        const project = targetProject(projectId, state.projects);
        const selectedEnvironment = state.environments.find(
            (candidate) => desktopEnvironmentKey(candidate.environment) === state.selectedEnvironmentKeys[0],
        );
        return project !== null && project !== undefined && selectedEnvironment !== undefined
            ? environmentMatchesProjectRoot(selectedEnvironment.environment, project.rootPath)
            : false;
    }

    public subscribe(listener: (state: DiscoveryState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    public dispose(): void {
        this.#generation += 1;
        this.#listeners.clear();
    }

    public async load(): Promise<void> {
        const generation = ++this.#generation;
        this.#transition(Object.freeze({ status: "loading", message: localizedText("discovery.loading") }));
        try {
            const [providers, enablement, watched, environments, projects] = await Promise.all([
                this.#client.listAdapterProviders(),
                this.#client.getAdapterEnablement(),
                this.#client.getWatchedScanIntent(),
                this.#client.listEnvironments(ALL_PLATFORMS),
                this.#client.listProjects({ includeDeleted: true }),
            ]);
            if (generation !== this.#generation) return;
            const failed = [providers, enablement, watched, environments, projects].find(
                (outcome) => outcome.status === "failed",
            );
            if (failed?.status === "failed") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("discovery.settings_unavailable"),
                        diagnostics: Object.freeze([...failed.diagnostics]),
                    }),
                );
                return;
            }
            if (
                providers.status === "failed" ||
                enablement.status === "failed" ||
                watched.status === "failed" ||
                environments.status === "failed" ||
                projects.status === "failed"
            ) {
                throw new Error("unreachable failed discovery outcome");
            }
            const ready = Object.freeze({
                status: "ready" as const,
                providers: providers.value.providers,
                enablement: enablement.value,
                selectedAdapterIds: Object.freeze(
                    this.#options.purpose === "target_discovery"
                        ? providers.value.providers.map((provider) => provider.adapterId).sort()
                        : [...enablement.value.enabledAdapterIds],
                ),
                watched: watched.value,
                environments: environments.value.environments,
                selectedEnvironmentKeys: initialEnvironmentKeys(
                    environments.value.environments,
                    projectEnvironmentConstraint(
                        this.#options.targetProjectId,
                        projects.value.projects,
                        watched.value,
                        environments.value.environments,
                    ),
                ),
                projects: projects.value.projects.filter((project) => !project.deleted),
                retainedProjects: projects.value.projects.filter((project) => project.deleted),
                probeReview: undefined,
                environmentReferences: Object.freeze([]),
                sources: Object.freeze([]),
                activity: "idle" as const,
                message: undefined,
                configurationDiagnostics: Object.freeze(
                    operationDiagnostics(
                        providers.diagnostics,
                        enablement.diagnostics,
                        watched.diagnostics,
                        environments.diagnostics,
                        projects.diagnostics,
                    ),
                ),
                activityDiagnostics: Object.freeze([]),
            });
            this.#transition(ready);
            const startupScope = this.#options.autoProbeWatched === false ? undefined : watchedProbeScope(ready);
            if (startupScope !== undefined) await this.#runProbe(startupScope, generation, { scope: "global" });
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("discovery.loading_failed"),
                        diagnostics: Object.freeze([]),
                    }),
                );
            }
        }
    }

    public toggleProvider(adapterId: string): void {
        if (!acceptsSelectionChange(this.#state)) return;
        const selected = new Set(this.#state.selectedAdapterIds);
        if (selected.has(adapterId)) selected.delete(adapterId);
        else selected.add(adapterId);
        this.#transition(
            Object.freeze({
                ...clearEnvironmentReferenceReview(this.#state),
                selectedAdapterIds: Object.freeze([...selected].sort()),
                sources: Object.freeze([]),
                activity: "idle",
                message: undefined,
                activityDiagnostics: Object.freeze([]),
            }),
        );
    }

    public setAllProvidersSelected(selected: boolean): void {
        if (!acceptsSelectionChange(this.#state)) return;
        const selectedAdapterIds = Object.freeze(
            selected ? this.#state.providers.map((provider) => provider.adapterId).sort() : [],
        );
        if (sameStringSet(selectedAdapterIds, this.#state.selectedAdapterIds)) return;
        this.#transition(
            Object.freeze({
                ...clearEnvironmentReferenceReview(this.#state),
                selectedAdapterIds,
                sources: Object.freeze([]),
                activity: "idle",
                message: undefined,
                activityDiagnostics: Object.freeze([]),
            }),
        );
    }

    public toggleEnvironment(key: string): void {
        if (!acceptsSelectionChange(this.#state) || !this.isEnvironmentSelectable(key)) return;
        const selected = this.projectEnvironmentConstrained
            ? new Set([key])
            : new Set(
                  this.#state.selectedEnvironmentKeys.includes(key)
                      ? this.#state.selectedEnvironmentKeys.filter((selectedKey) => selectedKey !== key)
                      : [...this.#state.selectedEnvironmentKeys, key],
              );
        this.#transition(
            Object.freeze({
                ...clearEnvironmentReferenceReview(this.#state),
                selectedEnvironmentKeys: Object.freeze([...selected]),
                sources: Object.freeze([]),
                activity: "idle",
                message: undefined,
                activityDiagnostics: Object.freeze([]),
            }),
        );
    }

    public async saveProviderEnablement(): Promise<boolean> {
        return this.#persistProviderEnablement();
    }

    public async saveProviderEnablementAndProbe(): Promise<void> {
        if (
            this.#state.status !== "ready" ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch" ||
            this.#state.selectedAdapterIds.length === 0 ||
            this.#state.selectedEnvironmentKeys.length === 0
        ) {
            return;
        }
        if (!(await this.#persistProviderEnablement())) return;
        await this.probe();
    }

    async #persistProviderEnablement(): Promise<boolean> {
        if (
            this.#state.status !== "ready" ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch"
        ) {
            return false;
        }
        if (sameStringSet(this.#state.selectedAdapterIds, this.#state.enablement.enabledAdapterIds)) return true;
        const generation = this.#generation;
        const current = this.#state;
        this.#transition(
            Object.freeze({
                ...current,
                activity: "saving",
                message: localizedText("discovery.provider.saving"),
                activityDiagnostics: Object.freeze([]),
            }),
        );
        try {
            const outcome = await this.#client.replaceAdapterEnablement({
                expectedRevision: current.enablement.revision,
                expectedSettingFingerprint: current.enablement.settingFingerprint,
                enabledAdapterIds: [...current.selectedAdapterIds],
                userActionId: this.#options.createUserActionId(),
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return false;
            if (outcome.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "save_failed",
                        message: localizedText("discovery.provider.save_failed"),
                        activityDiagnostics: Object.freeze(operationDiagnostics(outcome.diagnostics)),
                    }),
                );
                return false;
            }
            const enabled = new Set(outcome.value.enabledAdapterIds);
            this.#transition(
                Object.freeze({
                    ...clearEnvironmentReferenceReview(this.#state),
                    providers: Object.freeze(
                        this.#state.providers.map((provider) =>
                            Object.freeze({ ...provider, enabled: enabled.has(provider.adapterId) }),
                        ),
                    ),
                    enablement: outcome.value,
                    selectedAdapterIds: Object.freeze([...outcome.value.enabledAdapterIds]),
                    sources: Object.freeze([]),
                    activity: "idle",
                    message: localizedText("discovery.provider.saved"),
                    activityDiagnostics: Object.freeze(operationDiagnostics(outcome.diagnostics)),
                }),
            );
            return true;
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "save_failed",
                        message: localizedText("discovery.provider.save_failed"),
                        activityDiagnostics: Object.freeze([]),
                    }),
                );
            }
            return false;
        }
    }

    public async authorizeSelectedProvidersForTargetProbe(): Promise<boolean> {
        if (this.#options.purpose !== "target_discovery") return true;
        if (
            this.#state.status !== "ready" ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch"
        ) {
            return false;
        }
        const current = this.#state;
        const generation = this.#generation;
        if (!this.targetProbeAuthorizationRequired()) return true;
        this.#transition(
            Object.freeze({
                ...current,
                activity: "saving",
                message: localizedText("discovery.provider.saving"),
                activityDiagnostics: Object.freeze([]),
            }),
        );
        const outcome = await persistTargetProbeAuthorization(
            this.#client,
            current.enablement,
            current.selectedAdapterIds,
            this.#options.createUserActionId(),
        );
        if (generation !== this.#generation || this.#state.status !== "ready") return false;
        if (outcome.status !== "persisted") {
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    activity: "save_failed",
                    message: localizedText("discovery.provider.save_failed"),
                    activityDiagnostics: Object.freeze(
                        operationDiagnostics(outcome.status === "failed" ? outcome.diagnostics : []),
                    ),
                }),
            );
            return false;
        }
        const persisted = new Set(outcome.enablement.enabledAdapterIds);
        this.#transition(
            Object.freeze({
                ...this.#state,
                providers: Object.freeze(
                    this.#state.providers.map((provider) =>
                        Object.freeze({ ...provider, enabled: persisted.has(provider.adapterId) }),
                    ),
                ),
                enablement: outcome.enablement,
                selectedAdapterIds: outcome.selectedAdapterIds,
                activity: "idle",
                message: undefined,
                activityDiagnostics: Object.freeze(operationDiagnostics(outcome.diagnostics)),
            }),
        );
        return true;
    }

    public async probe(): Promise<boolean> {
        if (
            this.#state.status !== "ready" ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch"
        )
            return false;
        if (this.targetProbeAuthorizationRequired()) return false;
        const scope = this.#selectedProbeScope();
        if (scope === undefined) return false;
        const generation = this.#generation;
        return (await this.#runProbe(scope, generation, { scope: "global" })) !== undefined;
    }

    public async probeProject(localPathSelectionToken: string): Promise<boolean> {
        if (
            this.#state.status !== "ready" ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch" ||
            localPathSelectionToken.trim() === ""
        ) {
            return false;
        }
        if (this.targetProbeAuthorizationRequired()) return false;
        const scope = this.#selectedProbeScope();
        if (scope === undefined) return false;
        return (await this.#runProbe(scope, this.#generation, { scope: "project", localPathSelectionToken })) !== undefined;
    }

    public async probeInstallationRoot(
        adapterId: string,
        environment: EnvironmentListView["environments"][number]["environment"],
        installationRootSelectionToken: string,
        projectRootSelectionToken?: string,
    ): Promise<boolean> {
        if (
            this.#options.purpose !== "target_discovery" ||
            this.#state.status !== "ready" ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch" ||
            adapterId.trim() === "" ||
            installationRootSelectionToken.trim() === ""
        ) {
            return false;
        }
        const selectedEnvironment = this.#state.environments.find(
            (candidate) => desktopEnvironmentKey(candidate.environment) === desktopEnvironmentKey(environment),
        );
        if (
            selectedEnvironment === undefined ||
            !this.#state.providers.some((provider) => provider.adapterId === adapterId) ||
            !this.isEnvironmentSelectable(desktopEnvironmentKey(selectedEnvironment.environment)) ||
            (this.#options.targetProjectId !== undefined && projectRootSelectionToken?.trim() === "") ||
            (this.#options.targetProjectId !== undefined && projectRootSelectionToken === undefined)
        ) {
            return false;
        }
        this.#transition(
            Object.freeze({
                ...clearEnvironmentReferenceReview(this.#state),
                selectedAdapterIds: Object.freeze([adapterId]),
                selectedEnvironmentKeys: Object.freeze([desktopEnvironmentKey(selectedEnvironment.environment)]),
                sources: Object.freeze([]),
                message: undefined,
                activityDiagnostics: Object.freeze([]),
            }),
        );
        if (this.targetProbeAuthorizationRequired() || this.#state.status !== "ready") return false;
        const scope: DiscoveryProbeScope = {
            adapterIds: [adapterId],
            environments: [selectedEnvironment.environment],
        };
        let authorization: ProbeAuthorization;
        if (this.#options.targetProjectId === undefined) {
            authorization = { scope: "global", installationRootSelectionToken };
        } else {
            if (projectRootSelectionToken === undefined) return false;
            authorization = {
                scope: "project",
                localPathSelectionToken: projectRootSelectionToken,
                installationRootSelectionToken,
            };
        }
        const review = await this.#runProbe(scope, this.#generation, authorization);
        return (
            review?.results.some(
                (result) =>
                    result.adapterId === adapterId &&
                    desktopEnvironmentKey(result.environment) === desktopEnvironmentKey(selectedEnvironment.environment) &&
                    result.runtimes.some((runtime) => runtime.installationStatus === "available"),
            ) ?? false
        );
    }

    public async registerProject(
        localPathSelectionToken: string,
        displayName?: string,
    ): Promise<DiscoveryProjectRegistrationResult> {
        if (
            this.#state.status !== "ready" ||
            localPathSelectionToken.trim() === "" ||
            !this.#client.supportsOperation("project.register")
        ) {
            return Object.freeze({ status: "failed", diagnostics: Object.freeze([]) });
        }
        const generation = this.#generation;
        try {
            const normalizedDisplayName = displayName?.trim();
            const outcome = await this.#client.registerProject({
                localPathSelectionToken,
                ...(normalizedDisplayName === undefined || normalizedDisplayName === ""
                    ? {}
                    : { displayName: normalizedDisplayName }),
            });
            if (generation !== this.#generation || this.#state.status !== "ready" || outcome.status === "failed") {
                return Object.freeze({
                    status: "failed",
                    diagnostics: Object.freeze(outcome.status === "failed" ? [...outcome.diagnostics] : []),
                });
            }
            const projects = [
                ...this.#state.projects.filter((project) => project.projectId !== outcome.value.projectId),
                outcome.value,
            ].sort((left, right) => {
                const byName = left.displayName.localeCompare(right.displayName);
                return byName !== 0 ? byName : left.projectId.localeCompare(right.projectId);
            });
            this.#transition(Object.freeze({ ...this.#state, projects: Object.freeze(projects) }));
            void this.#reconcileProjectsAfterRegistration(generation, outcome.value);
            return Object.freeze({ status: "complete", project: outcome.value });
        } catch {
            return Object.freeze({ status: "failed", diagnostics: Object.freeze([]) });
        }
    }

    public applyRestoredProject(
        project: ProjectListView["projects"][number],
        expectedProjectId: string,
        expectedRootPath: string,
    ): boolean {
        if (
            this.#state.status !== "ready" ||
            project.deleted ||
            project.projectId !== expectedProjectId ||
            project.rootPath !== expectedRootPath ||
            !this.#state.retainedProjects.some(
                (candidate) => candidate.projectId === expectedProjectId && candidate.rootPath === expectedRootPath,
            )
        ) {
            return false;
        }
        const projects = [...this.#state.projects.filter((candidate) => candidate.projectId !== project.projectId), project].sort(
            (left, right) => {
                const byName = left.displayName.localeCompare(right.displayName);
                return byName !== 0 ? byName : left.projectId.localeCompare(right.projectId);
            },
        );
        this.#transition(
            Object.freeze({
                ...this.#state,
                projects: Object.freeze(projects),
                retainedProjects: Object.freeze(
                    this.#state.retainedProjects.filter((candidate) => candidate.projectId !== project.projectId),
                ),
            }),
        );
        return true;
    }

    async #reconcileProjectsAfterRegistration(
        generation: number,
        registeredProject: ProjectListView["projects"][number],
    ): Promise<void> {
        try {
            const outcome = await this.#client.listProjects({ includeDeleted: true });
            if (generation !== this.#generation || this.#state.status !== "ready" || outcome.status === "failed") return;
            const activeProjects = outcome.value.projects.filter((project) => !project.deleted);
            const projects = [
                ...activeProjects.filter((project) => project.projectId !== registeredProject.projectId),
                activeProjects.find((project) => project.projectId === registeredProject.projectId) ?? registeredProject,
            ].sort((left, right) => {
                const byName = left.displayName.localeCompare(right.displayName);
                return byName !== 0 ? byName : left.projectId.localeCompare(right.projectId);
            });
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    projects: Object.freeze(projects),
                    retainedProjects: Object.freeze(outcome.value.projects.filter((project) => project.deleted)),
                }),
            );
        } catch {
            // The immediate project.register receipt remains authoritative for this screen.
        }
    }

    public async saveWatchedSources(
        selections: readonly DiscoveryWatchSelection[],
        explicitlyExcludedSourceKeys: readonly string[] = [],
    ): Promise<boolean> {
        if (
            this.#state.status !== "ready" ||
            this.#state.probeReview === undefined ||
            this.#state.activity === "saving" ||
            this.#state.activity === "probing" ||
            this.#state.activity === "saving_watch"
        ) {
            return false;
        }
        const generation = this.#generation;
        const current = this.#state;
        const probeReview = current.probeReview;
        if (probeReview === undefined) return false;
        let decisions: ReturnType<typeof buildWatchedScanDecisions>;
        try {
            decisions = buildWatchedScanDecisions(
                probeReview.probeToken,
                current.sources,
                selections,
                explicitlyExcludedSourceKeys,
            );
        } catch {
            this.#transition(
                Object.freeze({
                    ...current,
                    activity: "watch_failed",
                    message: localizedText("discovery.watch.selection_invalid"),
                    activityDiagnostics: Object.freeze([]),
                }),
            );
            return false;
        }
        this.#transition(
            Object.freeze({
                ...current,
                activity: "saving_watch",
                message: localizedText("discovery.watch.saving"),
                activityDiagnostics: Object.freeze([]),
            }),
        );
        try {
            const outcome = await this.#client.replaceWatchedScanIntent({
                expectedRevision: current.watched.revision,
                expectedSettingFingerprint: current.watched.settingFingerprint,
                decisions: [...decisions],
                userActionId: this.#options.createUserActionId(),
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return false;
            if (outcome.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "watch_failed",
                        message: localizedText("discovery.watch.save_failed"),
                        activityDiagnostics: Object.freeze(operationDiagnostics(outcome.diagnostics)),
                    }),
                );
                return false;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    watched: outcome.value,
                    sources: classifyDiscoverySources(outcome.value, probeReview),
                    activity: "idle",
                    message: localizedText("discovery.watch.saved"),
                    activityDiagnostics: Object.freeze(operationDiagnostics(outcome.diagnostics)),
                }),
            );
            return true;
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "watch_failed",
                        message: localizedText("discovery.watch.save_failed"),
                        activityDiagnostics: Object.freeze([]),
                    }),
                );
            }
            return false;
        }
    }

    #selectedProbeScope(): DiscoveryProbeScope | undefined {
        if (this.#state.status !== "ready") return undefined;
        const current = this.#state;
        const resolution = resolveDiscoveryProbeScope(current);
        if (resolution.status !== "ready") {
            this.#transition(
                Object.freeze({
                    ...current,
                    activity: "probe_failed",
                    message: localizedText(
                        resolution.status === "no_provider" ? "discovery.enable_provider_first" : "discovery.no_environment",
                    ),
                }),
            );
            return undefined;
        }
        return resolution.scope;
    }

    async #runProbe(
        scope: DiscoveryProbeScope,
        generation: number,
        authorization: ProbeAuthorization,
    ): Promise<ProbeReviewView | undefined> {
        if (this.#state.status !== "ready") return undefined;
        const current = this.#state;
        this.#transition(
            Object.freeze({
                ...current,
                activity: "probing",
                message: localizedText("discovery.scanning"),
                activityDiagnostics: Object.freeze([]),
                probeProgress: initialDiscoveryProbeProgress(scope.adapterIds.length * scope.environments.length),
            }),
        );
        const onProbeUpdate: Parameters<DesktopApplicationClientApi["probeGlobal"]>[3] = (update) => {
            if (
                update.status !== "progress" ||
                generation !== this.#generation ||
                this.#state.status !== "ready" ||
                this.#state.activity !== "probing"
            ) {
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    probeProgress: applyDiscoveryProbeProgress(this.#state.probeProgress, update.progress),
                }),
            );
        };
        try {
            const outcome =
                authorization.scope === "global"
                    ? authorization.installationRootSelectionToken === undefined
                        ? await this.#client.probeGlobal(scope.adapterIds, scope.environments, undefined, onProbeUpdate)
                        : await this.#client.probeGlobal(
                              scope.adapterIds,
                              scope.environments,
                              authorization.installationRootSelectionToken,
                              onProbeUpdate,
                          )
                    : authorization.installationRootSelectionToken === undefined
                      ? await this.#client.probeProject(
                            scope.adapterIds,
                            scope.environments,
                            authorization.localPathSelectionToken,
                            undefined,
                            onProbeUpdate,
                        )
                      : await this.#client.probeProject(
                            scope.adapterIds,
                            scope.environments,
                            authorization.localPathSelectionToken,
                            authorization.installationRootSelectionToken,
                            onProbeUpdate,
                        );
            if (generation !== this.#generation || this.#state.status !== "ready") return undefined;
            if (outcome.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "probe_failed",
                        message: localizedText("discovery.snapshot_untrustworthy"),
                        activityDiagnostics: Object.freeze(operationDiagnostics(outcome.diagnostics)),
                    }),
                );
                return undefined;
            }
            const environmentReferenceQuery = await queryEnvironmentReferences(this.#client, outcome.value.probeToken);
            if (generation !== this.#generation || this.#state.status !== "ready") return undefined;
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    probeReview: outcome.value,
                    environmentReferences: environmentReferenceQuery.references,
                    sources: classifyDiscoverySources(this.#state.watched, outcome.value),
                    activity: "idle",
                    message: localizedText(
                        outcome.status === "partial" ? "discovery.complete_with_warnings" : "discovery.snapshot_refreshed",
                    ),
                    activityDiagnostics: Object.freeze(
                        operationDiagnostics(outcome.diagnostics, environmentReferenceQuery.diagnostics),
                    ),
                }),
            );
            return outcome.value;
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "probe_failed",
                        message: localizedText("discovery.interrupted"),
                        activityDiagnostics: Object.freeze([]),
                    }),
                );
            }
            return undefined;
        }
    }

    public hasUnsavedProviderChanges(): boolean {
        return this.#state.status === "ready" && providerSelectionChanged(this.#state.enablement, this.#state.selectedAdapterIds);
    }

    public targetProbeAuthorizationRequired(): boolean {
        return (
            this.#state.status === "ready" &&
            targetProbeAuthorizationRequired(this.#options.purpose, this.#state.enablement, this.#state.selectedAdapterIds)
        );
    }

    #transition(state: DiscoveryState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
