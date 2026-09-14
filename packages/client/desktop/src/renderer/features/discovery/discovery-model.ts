import type {
    ProtocolDiagnosticV1,
    ProtocolOperationName,
    ProtocolOperationResult,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import type { DesktopObservedProjectRootReference } from "../../../bridge/desktop-bridge";
import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import { protocolDiagnosticIdentity, uniqueProtocolDiagnostics } from "../../presentation/protocol-diagnostics";

type OutcomeValue<TName extends ProtocolOperationName> = Extract<
    ProtocolOperationResult<TName>,
    { readonly value: unknown }
>["value"];
type TerminalValue<TName extends "adapter.probe"> = Extract<
    ProtocolOperationTerminal<TName>,
    { readonly value: unknown }
>["value"];

export type AdapterProviderView = OutcomeValue<"adapter_provider.list">["providers"][number];
export type AdapterEnablementView = OutcomeValue<"adapter_enablement.get">;
export type WatchedScanIntentView = OutcomeValue<"watched_scan_intent.get">;
export type EnvironmentListView = OutcomeValue<"environment.list">;
export type ProjectListView = OutcomeValue<"project.list">;
export type ProbeReviewView = TerminalValue<"adapter.probe">;
export type ProbeEnvironmentReferenceView = OutcomeValue<"probe_environment_reference.list">["references"][number];
type WatchedSourceSelectorView = WatchedScanIntentView["environments"][number]["sourceSelectors"][number];
export type DiscoveryWatchBinding = Extract<WatchedSourceSelectorView, { readonly disposition: "included" }>["binding"];
export { buildWatchedScanDecisions } from "./discovery-watch-decisions";

export type DiscoverySourceStatus = "current" | "new" | "moved" | "missing" | "not_checked";
export type DiscoverySourceReadSelection =
    | { readonly status: "selectable"; readonly probeResultRowId: string; readonly sourceRootRowId: string }
    | { readonly status: "unavailable" };
export type DiscoverySourceWatchAvailability =
    | {
          readonly status: "selectable";
          readonly observed:
              | {
                    readonly probeResultRowId: string;
                    readonly sourceRootRowId: string;
                }
              | undefined;
          readonly prior:
              | {
                    readonly disposition: "included" | "excluded";
                    readonly selectorFingerprint: string;
                    readonly binding: DiscoveryWatchBinding | undefined;
                }
              | undefined;
      }
    | { readonly status: "unavailable" };

export interface DiscoveryWatchSelection {
    readonly sourceKey: string;
    readonly binding: DiscoveryWatchBinding;
}

export interface DiscoveryEnvironmentProbeOutcome {
    readonly environment: ProbeReviewView["results"][number]["environment"];
    readonly status: ProbeReviewView["results"][number]["status"];
    readonly tools: readonly DiscoveryToolProbeOutcome[];
}

export interface DiscoveryToolProbeOutcome {
    readonly adapterId: string;
    readonly status: ProbeReviewView["results"][number]["status"];
    readonly agentRuntimeIds: readonly string[];
    readonly versionTexts: readonly string[];
    readonly installationStatus: ProbeReviewView["results"][number]["runtimes"][number]["installationStatus"];
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly unscopedDiagnostics: readonly ProtocolDiagnosticV1[];
    readonly runtimeOutcomes: readonly DiscoveryRuntimeProbeOutcome[];
}

export interface DiscoveryRuntimeProbeOutcome {
    readonly agentRuntimeId: string;
    readonly versionText: string;
    readonly installationStatus: ProbeReviewView["results"][number]["runtimes"][number]["installationStatus"];
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
}

export interface DiscoveryProjectProposal {
    readonly key: string;
    readonly observedProjectIds: readonly string[];
    readonly displayName: string;
    readonly rootPath: string | undefined;
    readonly environment: ProbeReviewView["results"][number]["environment"];
    readonly adapterIds: readonly string[];
    readonly matchedProjectId: string | undefined;
    readonly matchedRetainedProjectId: string | undefined;
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly registrationReference: DesktopObservedProjectRootReference | undefined;
}

const INSTALLATION_ORDER = Object.freeze({
    available: 0,
    version_incompatible: 1,
    needs_permission: 2,
    unknown: 3,
    not_found: 4,
} as const);

function aggregateInstallationStatus(
    runtimes: ProbeReviewView["results"][number]["runtimes"],
): DiscoveryToolProbeOutcome["installationStatus"] {
    return (
        [...runtimes].sort(
            (left, right) => INSTALLATION_ORDER[left.installationStatus] - INSTALLATION_ORDER[right.installationStatus],
        )[0]?.installationStatus ?? "unknown"
    );
}

export function deriveDiscoveryEnvironmentProbeOutcomes(probe: ProbeReviewView): readonly DiscoveryEnvironmentProbeOutcome[] {
    const groups = new Map<
        string,
        {
            readonly environment: ProbeReviewView["results"][number]["environment"];
            readonly statuses: ProbeReviewView["results"][number]["status"][];
            readonly tools: DiscoveryToolProbeOutcome[];
        }
    >();
    for (const result of probe.results) {
        const key = desktopEnvironmentKey(result.environment);
        const group = groups.get(key) ?? {
            environment: result.environment,
            statuses: [],
            tools: [],
        };
        const runtimeOutcomes = result.runtimes
            .map((runtime) =>
                Object.freeze({
                    agentRuntimeId: runtime.agentRuntimeId,
                    versionText: runtime.versionText,
                    installationStatus: runtime.installationStatus,
                    diagnostics: uniqueProtocolDiagnostics(runtime.diagnostics),
                }),
            )
            .sort((left, right) => left.agentRuntimeId.localeCompare(right.agentRuntimeId));
        const runtimeDiagnosticIdentities = new Set(
            runtimeOutcomes.flatMap((runtime) => runtime.diagnostics.map(protocolDiagnosticIdentity)),
        );
        group.statuses.push(result.status);
        group.tools.push(
            Object.freeze({
                adapterId: result.adapterId,
                status: result.status,
                agentRuntimeIds: Object.freeze(result.runtimes.map((runtime) => runtime.agentRuntimeId).sort()),
                versionTexts: Object.freeze(
                    [
                        ...new Set(result.runtimes.map((runtime) => runtime.versionText).filter((version) => version !== "")),
                    ].sort(),
                ),
                installationStatus: aggregateInstallationStatus(result.runtimes),
                diagnostics: uniqueProtocolDiagnostics([
                    ...result.diagnostics,
                    ...result.runtimes.flatMap((runtime) => runtime.diagnostics),
                ]),
                unscopedDiagnostics: uniqueProtocolDiagnostics(result.diagnostics).filter(
                    (diagnostic) => !runtimeDiagnosticIdentities.has(protocolDiagnosticIdentity(diagnostic)),
                ),
                runtimeOutcomes: Object.freeze(runtimeOutcomes),
            }),
        );
        groups.set(key, group);
    }
    return Object.freeze(
        [...groups.entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([, group]) =>
                Object.freeze({
                    environment: group.environment,
                    status: group.statuses.every((status) => status === "complete")
                        ? ("complete" as const)
                        : group.statuses.every((status) => status === "failed")
                          ? ("failed" as const)
                          : ("partial" as const),
                    tools: Object.freeze(group.tools.sort((left, right) => left.adapterId.localeCompare(right.adapterId))),
                }),
            ),
    );
}

export function discoveryProviderContextReceipts(outcomes: readonly DiscoveryEnvironmentProbeOutcome[]): readonly unknown[] {
    return outcomes.flatMap((outcome) =>
        outcome.tools.map((tool) => [
            JSON.stringify([outcome.environment.platform, outcome.environment.platformInstanceId]),
            tool.adapterId,
            tool.status,
            tool.installationStatus,
            tool.agentRuntimeIds,
            tool.versionTexts,
            tool.diagnostics
                .map((diagnostic) => ({
                    code: diagnostic.code,
                    causeKind: diagnostic.causeKind,
                    path: diagnostic.path ?? "",
                }))
                .sort((left, right) =>
                    `${left.code}\0${left.causeKind}\0${left.path}`.localeCompare(
                        `${right.code}\0${right.causeKind}\0${right.path}`,
                    ),
                ),
        ]),
    );
}

export interface DiscoverySourceView {
    readonly key: string;
    readonly status: DiscoverySourceStatus;
    readonly adapterId: string;
    readonly environment: ProbeReviewView["results"][number]["environment"];
    readonly environmentLabel: string;
    readonly agentRuntimeIds: readonly string[];
    readonly rootRole: string;
    readonly sourceDomain: string;
    readonly displayPath: string;
    readonly priorDisplayPath: string;
    readonly accessStatus: string;
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly readSelection: DiscoverySourceReadSelection;
    readonly watchAvailability: DiscoverySourceWatchAvailability;
}

export type DiscoverySourceClaimKind = "native" | "compatible_shared" | "ambiguous_private" | "observed";

export interface DiscoverySourceClaimView {
    readonly claimKind: DiscoverySourceClaimKind;
    readonly source: DiscoverySourceView;
}

export interface DiscoverySourceClaimGroup {
    readonly key: string;
    readonly environment: ProbeReviewView["results"][number]["environment"];
    readonly environmentLabel: string;
    readonly displayPath: string;
    readonly status: DiscoverySourceStatus;
    readonly priorDisplayPath: string;
    readonly claims: readonly DiscoverySourceClaimView[];
    readonly primaryClaim: DiscoverySourceClaimView;
    readonly readableSourceKeys: readonly string[];
    readonly reviewSourceKeys: readonly string[];
    readonly watchSourceKey: string | undefined;
}

interface ComparableSource {
    readonly key: string;
    readonly scopeKey: string;
    readonly identity: string;
    readonly adapterId: string;
    readonly environment: ProbeReviewView["results"][number]["environment"];
    readonly environmentLabel: string;
    readonly agentRuntimeIds: readonly string[];
    readonly rootRole: string;
    readonly sourceDomain: string;
    readonly displayPath: string;
    readonly accessStatus: string;
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly readSelection: DiscoverySourceReadSelection;
    readonly observed:
        | {
              readonly probeResultRowId: string;
              readonly sourceRootRowId: string;
              readonly locatorKindsKnown: boolean;
          }
        | undefined;
    readonly prior:
        | {
              readonly disposition: "included" | "excluded";
              readonly selectorFingerprint: string;
              readonly binding: DiscoveryWatchBinding | undefined;
          }
        | undefined;
}

function probeScopeKey(adapterId: string, environmentLabel: string): string {
    return `${adapterId}\0${environmentLabel}`;
}

function sorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

function sourceIdentity(input: {
    readonly adapterId: string;
    readonly environmentLabel: string;
    readonly agentRuntimeIds: readonly string[];
    readonly rootRole: string;
    readonly sourceDomain: string;
    readonly locatorIdentities: readonly { readonly locatorKind: string; readonly locatorKey: string }[];
}): string {
    return JSON.stringify([
        input.adapterId,
        input.environmentLabel,
        sorted(input.agentRuntimeIds),
        input.rootRole,
        input.sourceDomain,
        input.locatorIdentities.map((locator) => `${locator.locatorKind}\0${locator.locatorKey}`).sort(),
    ]);
}

function freshSources(probe: ProbeReviewView): ComparableSource[] {
    return probe.results.flatMap((result) => {
        const environmentLabel = `${result.environment.platform}:${result.environment.platformInstanceId}`;
        return result.sources.map((source) => {
            const agentRuntimeIds = sorted(
                result.runtimes
                    .filter((runtime) => runtime.sourceRootRowIds.includes(source.rowId))
                    .map((runtime) => runtime.agentRuntimeId),
            );
            return {
                key: `fresh:${result.rowId}:${source.rowId}`,
                scopeKey: probeScopeKey(result.adapterId, environmentLabel),
                identity: sourceIdentity({
                    adapterId: result.adapterId,
                    environmentLabel,
                    agentRuntimeIds,
                    rootRole: source.rootRole,
                    sourceDomain: source.sourceDomain,
                    locatorIdentities: source.locatorIdentities,
                }),
                adapterId: result.adapterId,
                environment: result.environment,
                environmentLabel,
                agentRuntimeIds,
                rootRole: source.rootRole,
                sourceDomain: source.sourceDomain,
                displayPath: source.displayPath,
                accessStatus: source.accessStatus,
                diagnostics: source.diagnostics,
                readSelection:
                    source.accessStatus === "available"
                        ? {
                              status: "selectable" as const,
                              probeResultRowId: result.rowId,
                              sourceRootRowId: source.rowId,
                          }
                        : { status: "unavailable" as const },
                observed: {
                    probeResultRowId: result.rowId,
                    sourceRootRowId: source.rowId,
                    locatorKindsKnown: source.locatorIdentities.every((locator) => locator.locatorKind !== "unknown"),
                },
                prior: undefined,
            };
        });
    });
}

function watchedSources(watched: WatchedScanIntentView): ComparableSource[] {
    return watched.environments.flatMap((environment) => {
        const environmentLabel = `${environment.environment.platform}:${environment.environment.platformInstanceId}`;
        return environment.sourceSelectors.map((selector) => {
            const binding = selector.disposition === "included" ? selector.binding : undefined;
            return {
                key: `watched:${selector.selectorFingerprint}`,
                scopeKey: probeScopeKey(selector.source.adapterId, environmentLabel),
                identity: sourceIdentity({
                    adapterId: selector.source.adapterId,
                    environmentLabel,
                    agentRuntimeIds: selector.agentRuntimeIds,
                    rootRole: selector.source.rootRole,
                    sourceDomain: selector.source.sourceDomain,
                    locatorIdentities: selector.source.locatorIdentities,
                }),
                adapterId: selector.source.adapterId,
                environment: environment.environment,
                environmentLabel,
                agentRuntimeIds: sorted(selector.agentRuntimeIds),
                rootRole: selector.source.rootRole,
                sourceDomain: selector.source.sourceDomain,
                displayPath: selector.source.canonicalPath,
                accessStatus: "unknown",
                diagnostics: Object.freeze([]),
                readSelection: { status: "unavailable" as const },
                observed: undefined,
                prior: {
                    disposition: selector.disposition,
                    selectorFingerprint: selector.selectorFingerprint,
                    binding,
                },
            };
        });
    });
}

function view(
    source: ComparableSource,
    status: DiscoverySourceStatus,
    prior: ComparableSource["prior"] = source.prior,
    priorDisplayPath = "",
): DiscoverySourceView {
    const observed = source.observed;
    const observedWatchable =
        observed !== undefined &&
        source.accessStatus === "available" &&
        source.agentRuntimeIds.length > 0 &&
        source.rootRole !== "unknown" &&
        source.sourceDomain !== "unknown" &&
        observed.locatorKindsKnown;
    return Object.freeze({
        key: source.key,
        status,
        adapterId: source.adapterId,
        environment: source.environment,
        environmentLabel: source.environmentLabel,
        agentRuntimeIds: source.agentRuntimeIds,
        rootRole: source.rootRole,
        sourceDomain: source.sourceDomain,
        displayPath: source.displayPath,
        priorDisplayPath,
        accessStatus: source.accessStatus,
        diagnostics: source.diagnostics,
        readSelection: source.readSelection,
        watchAvailability:
            prior !== undefined || observedWatchable
                ? {
                      status: "selectable" as const,
                      observed:
                          observedWatchable && observed !== undefined
                              ? {
                                    probeResultRowId: observed.probeResultRowId,
                                    sourceRootRowId: observed.sourceRootRowId,
                                }
                              : undefined,
                      prior,
                  }
                : { status: "unavailable" as const },
    });
}

function statusForPriorComparison(
    source: ComparableSource,
    availableStatus: Extract<DiscoverySourceStatus, "current" | "moved">,
    probeScopeComplete: boolean,
): DiscoverySourceStatus {
    if (source.accessStatus === "available") return availableStatus;
    return source.accessStatus === "not_found" && probeScopeComplete ? "missing" : "not_checked";
}

export function classifyDiscoverySources(watched: WatchedScanIntentView, probe: ProbeReviewView): readonly DiscoverySourceView[] {
    const fresh = freshSources(probe);
    const completeProbeScopes = new Set(
        probe.results
            .filter((result) => result.status === "complete")
            .map((result) =>
                probeScopeKey(result.adapterId, `${result.environment.platform}:${result.environment.platformInstanceId}`),
            ),
    );
    const consumedFreshKeys = new Set<string>();
    const classified: DiscoverySourceView[] = [];

    for (const prior of watchedSources(watched)) {
        const exact = fresh.find(
            (candidate) =>
                !consumedFreshKeys.has(candidate.key) &&
                candidate.identity === prior.identity &&
                candidate.displayPath === prior.displayPath,
        );
        if (exact !== undefined) {
            consumedFreshKeys.add(exact.key);
            classified.push(
                view(exact, statusForPriorComparison(exact, "current", completeProbeScopes.has(prior.scopeKey)), prior.prior),
            );
            continue;
        }
        const moved = fresh.find((candidate) => !consumedFreshKeys.has(candidate.key) && candidate.identity === prior.identity);
        if (moved !== undefined) {
            consumedFreshKeys.add(moved.key);
            if (moved.accessStatus === "available") {
                classified.push(view(moved, "moved", prior.prior, prior.displayPath));
            } else {
                classified.push(
                    view(
                        prior,
                        moved.accessStatus === "not_found" && completeProbeScopes.has(prior.scopeKey) ? "missing" : "not_checked",
                    ),
                );
            }
            continue;
        }
        classified.push(view(prior, completeProbeScopes.has(prior.scopeKey) ? "missing" : "not_checked"));
    }

    for (const source of fresh) {
        if (!consumedFreshKeys.has(source.key) && source.accessStatus === "available") classified.push(view(source, "new"));
    }
    return Object.freeze(classified);
}

/**
 * A guided-import journey may compare fresh observations with prior watched intent, but it must
 * never surface a prior source from an Environment or Provider outside the current probe.
 *
 * The full classified collection remains owned by DiscoveryController so a later watched-intent
 * replacement can retain hidden prior decisions. This projection is only for the current journey's
 * visible review, read request and preview handoff.
 */
export function projectDiscoverySourcesForProbe(
    sources: readonly DiscoverySourceView[],
    probe: ProbeReviewView,
): readonly DiscoverySourceView[] {
    const currentScopes = new Set(
        probe.results.map((result) =>
            probeScopeKey(result.adapterId, `${result.environment.platform}:${result.environment.platformInstanceId}`),
        ),
    );
    return Object.freeze(sources.filter((source) => currentScopes.has(probeScopeKey(source.adapterId, source.environmentLabel))));
}

/**
 * Project proposals preserve every exact available workspace root reported by the probe.
 *
 * A multi-workspace observation does not establish one canonical OAAM Project root. Instead,
 * every exact source-row member becomes its own reviewable folder candidate. The user's later
 * choice supplies the authority; row order, display names and path containment never do.
 */
export function deriveDiscoveryProjectProposals(
    probe: ProbeReviewView,
    projects: ProjectListView["projects"],
): readonly DiscoveryProjectProposal[] {
    const grouped = new Map<
        string,
        {
            observedProjectIds: Set<string>;
            displayNames: Set<string>;
            rootPath: string | undefined;
            environment: ProbeReviewView["results"][number]["environment"];
            adapterIds: Set<string>;
            diagnostics: ProtocolDiagnosticV1[];
            registrationReferences: DesktopObservedProjectRootReference[];
        }
    >();
    for (const result of probe.results) {
        for (const project of result.projects) {
            const availableWorkspaceSources = project.workspaceSourceRowIds.flatMap((rowId) => {
                const source = result.sources.find((candidate) => candidate.rowId === rowId);
                return source?.accessStatus === "available" ? [source] : [];
            });
            const candidates = availableWorkspaceSources.length === 0 ? [undefined] : availableWorkspaceSources;
            for (const source of candidates) {
                const rootPath = source?.displayPath;
                const key =
                    rootPath === undefined
                        ? `${result.environment.platform}\0${result.environment.platformInstanceId}\0${result.adapterId}\0${project.observedProjectId}`
                        : `${result.environment.platform}\0${result.environment.platformInstanceId}\0${rootPath}`;
                const entry = grouped.get(key) ?? {
                    observedProjectIds: new Set<string>(),
                    displayNames: new Set<string>(),
                    rootPath,
                    environment: result.environment,
                    adapterIds: new Set<string>(),
                    diagnostics: [],
                    registrationReferences: [],
                };
                entry.observedProjectIds.add(project.observedProjectId);
                if (project.displayName.trim() !== "") entry.displayNames.add(project.displayName);
                entry.adapterIds.add(result.adapterId);
                entry.diagnostics.push(...project.diagnostics);
                if (source !== undefined) {
                    entry.registrationReferences.push({
                        probeToken: probe.probeToken,
                        probeResultRowId: result.rowId,
                        projectRowId: project.rowId,
                        sourceRootRowId: source.rowId,
                    });
                }
                grouped.set(key, entry);
            }
        }
    }
    return Object.freeze(
        [...grouped.entries()]
            .map(([key, entry]) => {
                const displayName = [...entry.displayNames].sort()[0] ?? entry.rootPath ?? key;
                const registrationReference = [...entry.registrationReferences].sort((left, right) => {
                    const leftKey = `${left.probeResultRowId}\0${left.projectRowId}\0${left.sourceRootRowId}`;
                    const rightKey = `${right.probeResultRowId}\0${right.projectRowId}\0${right.sourceRootRowId}`;
                    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
                })[0];
                const activeProject =
                    entry.rootPath === undefined
                        ? undefined
                        : projects.find((project) => !project.deleted && project.rootPath === entry.rootPath);
                const retainedProject =
                    entry.rootPath === undefined
                        ? undefined
                        : projects.find((project) => project.deleted && project.rootPath === entry.rootPath);
                return Object.freeze({
                    key,
                    observedProjectIds: Object.freeze([...entry.observedProjectIds].sort()),
                    displayName,
                    rootPath: entry.rootPath,
                    environment: entry.environment,
                    adapterIds: Object.freeze([...entry.adapterIds].sort()),
                    matchedProjectId: activeProject?.projectId,
                    matchedRetainedProjectId: activeProject === undefined ? retainedProject?.projectId : undefined,
                    diagnostics: Object.freeze(uniqueProtocolDiagnostics(entry.diagnostics)),
                    registrationReference,
                });
            })
            .sort((left, right) => {
                const leftKey = `${left.environment.platform}\0${left.environment.platformInstanceId}\0${left.rootPath ?? left.key}`;
                const rightKey = `${right.environment.platform}\0${right.environment.platformInstanceId}\0${right.rootPath ?? right.key}`;
                return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
            }),
    );
}

const CLAIM_ORDER = Object.freeze({
    native: 0,
    compatible_shared: 1,
    observed: 2,
    ambiguous_private: 3,
} as const);

function groupedSourceStatus(claims: readonly DiscoverySourceView[]): {
    readonly status: DiscoverySourceStatus;
    readonly priorDisplayPath: string;
} {
    const current = claims.find((claim) => claim.status === "current");
    if (current !== undefined) return { status: "current", priorDisplayPath: "" };
    const moved = claims.find((claim) => claim.status === "moved");
    if (moved !== undefined) return { status: "moved", priorDisplayPath: moved.priorDisplayPath };
    if (claims.some((claim) => claim.status === "new")) return { status: "new", priorDisplayPath: "" };
    if (claims.every((claim) => claim.status === "missing")) return { status: "missing", priorDisplayPath: "" };
    return { status: "not_checked", priorDisplayPath: "" };
}

export function groupDiscoverySourceClaims(
    sources: readonly DiscoverySourceView[],
    probe: ProbeReviewView,
): readonly DiscoverySourceClaimGroup[] {
    const providerInstallationOrder = new Map<string, number>();
    for (const result of probe.results) {
        const best = result.runtimes.reduce(
            (current, runtime) => Math.min(current, INSTALLATION_ORDER[runtime.installationStatus]),
            Number.POSITIVE_INFINITY,
        );
        providerInstallationOrder.set(
            result.adapterId,
            Math.min(providerInstallationOrder.get(result.adapterId) ?? Number.POSITIVE_INFINITY, best),
        );
    }
    const groups = new Map<string, DiscoverySourceView[]>();
    for (const source of sources) {
        const key = JSON.stringify([source.environmentLabel, source.displayPath]);
        const group = groups.get(key) ?? [];
        group.push(source);
        groups.set(key, group);
    }
    return Object.freeze(
        [...groups.entries()]
            .map(([key, claims]) => {
                const privateClaimCount = claims.filter((claim) => claim.sourceDomain === "agent_runtime_private").length;
                const sortedClaims = claims
                    .map((source) =>
                        Object.freeze({
                            claimKind:
                                source.sourceDomain === "agent_runtime_private"
                                    ? privateClaimCount === 1
                                        ? ("native" as const)
                                        : ("ambiguous_private" as const)
                                    : source.sourceDomain === "family_shared"
                                      ? ("compatible_shared" as const)
                                      : ("observed" as const),
                            source,
                        }),
                    )
                    .sort((left, right) => {
                        const relationshipOrder = CLAIM_ORDER[left.claimKind] - CLAIM_ORDER[right.claimKind];
                        if (relationshipOrder !== 0) return relationshipOrder;
                        const installationOrder =
                            (providerInstallationOrder.get(left.source.adapterId) ?? Number.POSITIVE_INFINITY) -
                            (providerInstallationOrder.get(right.source.adapterId) ?? Number.POSITIVE_INFINITY);
                        if (installationOrder !== 0) return installationOrder;
                        const adapterOrder = left.source.adapterId.localeCompare(right.source.adapterId);
                        return adapterOrder === 0 ? left.source.key.localeCompare(right.source.key) : adapterOrder;
                    });
                const primaryClaim = sortedClaims[0];
                if (primaryClaim === undefined) throw new TypeError("source claim group cannot be empty");
                const priorIncluded = sortedClaims.find(
                    (claim) =>
                        claim.source.watchAvailability.status === "selectable" &&
                        claim.source.watchAvailability.prior?.disposition === "included",
                );
                const nativeWatchable = sortedClaims.find(
                    (claim) => claim.claimKind === "native" && claim.source.watchAvailability.status === "selectable",
                );
                const firstWatchable = sortedClaims.find((claim) => claim.source.watchAvailability.status === "selectable");
                const readableClaims = sortedClaims.filter((claim) => claim.source.readSelection.status === "selectable");
                const readableNativeClaims = readableClaims.filter((claim) => claim.claimKind === "native");
                const readableAmbiguousPrivateClaims = readableClaims.filter((claim) => claim.claimKind === "ambiguous_private");
                const reviewClaims =
                    readableNativeClaims.length === 1
                        ? readableNativeClaims
                        : readableAmbiguousPrivateClaims.length > 0
                          ? readableAmbiguousPrivateClaims
                          : readableClaims.slice(0, 1);
                const groupedStatus = groupedSourceStatus(claims);
                return Object.freeze({
                    key,
                    environment: primaryClaim.source.environment,
                    environmentLabel: claims[0]?.environmentLabel ?? "",
                    displayPath: claims[0]?.displayPath ?? "",
                    status: groupedStatus.status,
                    priorDisplayPath: groupedStatus.priorDisplayPath,
                    claims: Object.freeze(sortedClaims),
                    primaryClaim,
                    readableSourceKeys: Object.freeze(readableClaims.map((claim) => claim.source.key)),
                    reviewSourceKeys: Object.freeze(reviewClaims.map((claim) => claim.source.key)),
                    watchSourceKey: (priorIncluded ?? nativeWatchable ?? firstWatchable)?.source.key,
                });
            })
            .sort((left, right) => {
                const environmentOrder = left.environmentLabel.localeCompare(right.environmentLabel);
                return environmentOrder === 0 ? left.displayPath.localeCompare(right.displayPath) : environmentOrder;
            }),
    );
}

function sameBinding(left: DiscoveryWatchBinding | undefined, right: DiscoveryWatchBinding): boolean {
    if (left === undefined || left.assetScope !== right.assetScope) return false;
    return left.assetScope === "global" || (right.assetScope === "project" && left.projectId === right.projectId);
}

export function discoverySourceGroupHasWatchDestination(
    group: DiscoverySourceClaimGroup,
    selections: readonly DiscoveryWatchSelection[],
    projects: ProjectListView["projects"],
): boolean {
    const sourceKeys = new Set(group.claims.map((claim) => claim.source.key));
    const groupSelections = selections.filter((selection) => sourceKeys.has(selection.sourceKey));
    const firstSelection = groupSelections[0];
    if (
        firstSelection === undefined ||
        !groupSelections.every((selection) => sameBinding(firstSelection.binding, selection.binding))
    ) {
        return false;
    }
    if (firstSelection.binding.assetScope === "global") return true;
    const projectId = firstSelection.binding.projectId;
    return projects.some((project) => !project.deleted && project.projectId === projectId);
}

function isProjectSource(source: DiscoverySourceView): boolean {
    return (
        source.rootRole === "project_actual" || source.sourceDomain === "project_root" || source.sourceDomain === "project_keyed"
    );
}

/** Exact environment and root identity are the only Project-proposal join authority. */
export function discoveryProjectProposalForSourceGroup(
    group: DiscoverySourceClaimGroup,
    proposals: readonly DiscoveryProjectProposal[],
): DiscoveryProjectProposal | undefined {
    if (!group.claims.some((claim) => isProjectSource(claim.source))) return undefined;
    const matches = proposals.filter(
        (proposal) =>
            proposal.rootPath === group.displayPath &&
            proposal.environment.platform === group.environment.platform &&
            proposal.environment.platformInstanceId === group.environment.platformInstanceId,
    );
    return matches.length === 1 ? matches[0] : undefined;
}

function projectBindingForPath(displayPath: string, projects: ProjectListView["projects"]): DiscoveryWatchBinding | undefined {
    const project = projects.find((candidate) => !candidate.deleted && candidate.rootPath === displayPath);
    return project === undefined ? undefined : { assetScope: "project", projectId: project.projectId };
}

export function discoveryWatchBindingForInclusion(
    group: DiscoverySourceClaimGroup,
    projects: ProjectListView["projects"],
): DiscoveryWatchBinding | undefined {
    const priorIncluded = group.claims.find(
        (claim) =>
            claim.source.watchAvailability.status === "selectable" &&
            claim.source.watchAvailability.prior?.disposition === "included" &&
            claim.source.watchAvailability.prior.binding !== undefined,
    );
    if (
        priorIncluded?.source.watchAvailability.status === "selectable" &&
        priorIncluded.source.watchAvailability.prior?.binding !== undefined
    ) {
        return priorIncluded.source.watchAvailability.prior.binding;
    }
    const watchSource = group.claims.find((claim) => claim.source.key === group.watchSourceKey)?.source;
    if (
        watchSource?.watchAvailability.status !== "selectable" ||
        watchSource.watchAvailability.observed === undefined ||
        watchSource.status === "missing" ||
        watchSource.status === "not_checked"
    ) {
        return undefined;
    }
    if (group.claims.some((claim) => isProjectSource(claim.source))) {
        return projectBindingForPath(group.displayPath, projects);
    }
    return watchSource.sourceDomain === "agent_runtime_private" || watchSource.sourceDomain === "family_shared"
        ? { assetScope: "global" }
        : undefined;
}

export function reconcileDiscoveryWatchSelectionsForRegisteredProject(
    groups: readonly DiscoverySourceClaimGroup[],
    selectedSourceKeys: readonly string[],
    selections: readonly DiscoveryWatchSelection[],
    projects: ProjectListView["projects"],
    project: ProjectListView["projects"][number],
): readonly DiscoveryWatchSelection[] {
    const selectedKeySet = new Set(selectedSourceKeys);
    const replacements = groups.flatMap((group) => {
        if (
            group.displayPath !== project.rootPath ||
            group.reviewSourceKeys.length === 0 ||
            !group.reviewSourceKeys.every((key) => selectedKeySet.has(key))
        ) {
            return [];
        }
        const binding = discoveryWatchBindingForInclusion(group, [...projects, project]);
        return binding?.assetScope === "project" && binding.projectId === project.projectId && group.watchSourceKey !== undefined
            ? [{ group, sourceKey: group.watchSourceKey, binding }]
            : [];
    });
    if (replacements.length === 0) return selections;
    const reboundSourceKeys = new Set(replacements.flatMap(({ group }) => group.claims.map((claim) => claim.source.key)));
    return Object.freeze([
        ...selections.filter((selection) => !reboundSourceKeys.has(selection.sourceKey)),
        ...replacements.map(({ sourceKey, binding }) => Object.freeze({ sourceKey, binding })),
    ]);
}

export function defaultDiscoveryWatchSelections(
    sources: readonly DiscoverySourceView[],
    projects: ProjectListView["projects"] = [],
): readonly DiscoveryWatchSelection[] {
    const selections: DiscoveryWatchSelection[] = [...persistedDiscoveryWatchSelections(sources)];
    const grouped = new Map<string, DiscoverySourceView[]>();
    for (const source of sources) {
        const key = JSON.stringify([source.environmentLabel, source.displayPath]);
        const group = grouped.get(key) ?? [];
        group.push(source);
        grouped.set(key, group);
    }
    for (const group of grouped.values()) {
        if (
            group.some(
                (source) => source.watchAvailability.status === "selectable" && source.watchAvailability.prior !== undefined,
            )
        ) {
            continue;
        }
        const projectSources = group.filter(
            (source) =>
                isProjectSource(source) &&
                source.status !== "missing" &&
                source.status !== "not_checked" &&
                source.watchAvailability.status === "selectable" &&
                source.watchAvailability.observed !== undefined,
        );
        const native = group.filter(
            (source) =>
                source.sourceDomain === "agent_runtime_private" &&
                source.status !== "missing" &&
                source.status !== "not_checked" &&
                source.watchAvailability.status === "selectable" &&
                source.watchAvailability.observed !== undefined,
        );
        const familyShared = group.filter(
            (source) =>
                source.sourceDomain === "family_shared" &&
                source.status !== "missing" &&
                source.status !== "not_checked" &&
                source.watchAvailability.status === "selectable" &&
                source.watchAvailability.observed !== undefined,
        );
        const source =
            projectSources.length > 0
                ? projectSources[0]
                : native.length === 1
                  ? native[0]
                  : native.length === 0 && familyShared.length > 0
                    ? familyShared[0]
                    : undefined;
        if (source !== undefined) {
            const binding =
                projectSources.length > 0
                    ? projectBindingForPath(source.displayPath, projects)
                    : ({ assetScope: "global" } as const);
            if (binding !== undefined) selections.push(Object.freeze({ sourceKey: source.key, binding }));
        }
    }
    return Object.freeze(selections);
}

export function persistedDiscoveryWatchSelections(sources: readonly DiscoverySourceView[]): readonly DiscoveryWatchSelection[] {
    return Object.freeze(
        sources.flatMap((source) => {
            if (source.watchAvailability.status !== "selectable") return [];
            const prior = source.watchAvailability.prior;
            return prior?.disposition === "included" && prior.binding !== undefined
                ? [Object.freeze({ sourceKey: source.key, binding: prior.binding })]
                : [];
        }),
    );
}

export function defaultDiscoveryReadSourceKeys(groups: readonly DiscoverySourceClaimGroup[]): readonly string[] {
    return Object.freeze(
        groups.flatMap((group) => {
            const priorDispositions = group.claims.flatMap((candidate) =>
                candidate.source.watchAvailability.status === "selectable" &&
                candidate.source.watchAvailability.prior !== undefined
                    ? [candidate.source.watchAvailability.prior.disposition]
                    : [],
            );
            if (priorDispositions.includes("excluded") && !priorDispositions.includes("included")) {
                return [];
            }
            const reviewClaims = group.claims.filter((claim) => group.reviewSourceKeys.includes(claim.source.key));
            if (reviewClaims.length !== 1) return [];
            const claim = reviewClaims[0];
            if (claim?.source.readSelection.status !== "selectable") return [];
            if (claim.claimKind !== "native" && group.claims.some((candidate) => candidate.claimKind === "native")) return [];
            return claim.claimKind === "ambiguous_private" ? [] : group.reviewSourceKeys;
        }),
    );
}

export function discoverySourceGroupDefaultsIncluded(group: DiscoverySourceClaimGroup): boolean {
    return defaultDiscoveryReadSourceKeys([group]).length > 0;
}

export { buildReadSourceRequest } from "./discovery-read-source-request";

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    const canonicalLeft = sorted(left);
    const canonicalRight = sorted(right);
    return (
        canonicalLeft.length === canonicalRight.length && canonicalLeft.every((value, index) => value === canonicalRight[index])
    );
}
