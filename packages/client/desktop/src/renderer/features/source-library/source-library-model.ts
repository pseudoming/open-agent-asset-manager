import { projectDisplayName } from "../../presentation/project-label";
import type { ProtocolEnvironmentSelectorV1, ProtocolOperationResult } from "@oaam/app-server-protocol";

type OutcomeValue<TName extends "adapter_provider.list" | "project.list" | "watched_scan_intent.get"> = Extract<
    ProtocolOperationResult<TName>,
    { readonly value: unknown }
>["value"];

export type SourceLibraryProvider = OutcomeValue<"adapter_provider.list">["providers"][number];
export type SourceLibraryProject = OutcomeValue<"project.list">["projects"][number];
export type SourceLibraryIntent = OutcomeValue<"watched_scan_intent.get">;

export function countIncludedSourceLocations(intent: SourceLibraryIntent): number {
    return intent.environments.reduce(
        (count, environment) =>
            count +
            new Set(
                environment.sourceSelectors
                    .filter((selector) => selector.disposition === "included")
                    .map((selector) => selector.source.canonicalPath),
            ).size,
        0,
    );
}
type SourceLibrarySelector = SourceLibraryIntent["environments"][number]["sourceSelectors"][number];
type IncludedSourceLibrarySelector = Extract<SourceLibrarySelector, { readonly disposition: "included" }>;

export interface SourceLibraryTool {
    readonly adapterId: string;
    readonly displayName: string | undefined;
    readonly agentRuntimeIds: readonly string[];
}

export interface SourceLibraryClaim {
    readonly adapterId: string;
    readonly rootRole: IncludedSourceLibrarySelector["source"]["rootRole"];
    readonly sourceDomain: IncludedSourceLibrarySelector["source"]["sourceDomain"];
    readonly locatorIdentities: IncludedSourceLibrarySelector["source"]["locatorIdentities"];
    readonly selectorFingerprint: string;
}

export type SourceLibraryDestination =
    | { readonly scope: "global" }
    | { readonly scope: "project"; readonly projectId: string; readonly projectName: string | undefined };

export interface SourceLibraryLocation {
    readonly key: string;
    readonly environment: ProtocolEnvironmentSelectorV1;
    readonly canonicalPath: string;
    readonly tools: readonly SourceLibraryTool[];
    readonly claims: readonly SourceLibraryClaim[];
    readonly destinations: readonly SourceLibraryDestination[];
}

export interface SourceLibraryEnvironment {
    readonly key: string;
    readonly environment: ProtocolEnvironmentSelectorV1;
    readonly sources: readonly SourceLibraryLocation[];
}

function compareDisplayText(left: string, right: string): number {
    const foldedLeft = left.toLocaleLowerCase("en-US");
    const foldedRight = right.toLocaleLowerCase("en-US");
    if (foldedLeft < foldedRight) return -1;
    if (foldedLeft > foldedRight) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

export function sourceEnvironmentKey(environment: ProtocolEnvironmentSelectorV1): string {
    return JSON.stringify([environment.platform, environment.platformInstanceId]);
}

export function sourceLocationKey(environment: ProtocolEnvironmentSelectorV1, canonicalPath: string): string {
    return JSON.stringify([environment.platform, environment.platformInstanceId, canonicalPath]);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(values)].sort(compareDisplayText));
}

function destinationKey(destination: SourceLibraryDestination): string {
    return destination.scope === "global" ? "global" : `project:${destination.projectId}`;
}

export function buildSourceLibrary(
    providers: readonly SourceLibraryProvider[],
    intent: SourceLibraryIntent,
    projects: readonly SourceLibraryProject[],
): readonly SourceLibraryEnvironment[] {
    const providerNames = new Map(providers.map((provider) => [provider.adapterId, provider.displayName] as const));
    const projectNames = new Map(
        projects
            .filter((project) => !project.deleted)
            .map((project) => [project.projectId, projectDisplayName(project)] as const),
    );
    const environments = intent.environments.map((entry) => {
        const groups = new Map<string, IncludedSourceLibrarySelector[]>();
        for (const selector of entry.sourceSelectors) {
            if (selector.disposition !== "included") continue;
            const group = groups.get(selector.source.canonicalPath) ?? [];
            group.push(selector);
            groups.set(selector.source.canonicalPath, group);
        }
        const sources = [...groups.entries()]
            .sort(([left], [right]) => compareDisplayText(left, right))
            .map(([canonicalPath, selectors]) => {
                const toolsByAdapter = new Map<string, string[]>();
                const destinationsByKey = new Map<string, SourceLibraryDestination>();
                const claims = selectors.map((selector) => {
                    toolsByAdapter.set(selector.source.adapterId, [
                        ...(toolsByAdapter.get(selector.source.adapterId) ?? []),
                        ...selector.agentRuntimeIds,
                    ]);
                    const destination: SourceLibraryDestination =
                        selector.binding.assetScope === "global"
                            ? { scope: "global" }
                            : {
                                  scope: "project",
                                  projectId: selector.binding.projectId,
                                  projectName: projectNames.get(selector.binding.projectId),
                              };
                    destinationsByKey.set(destinationKey(destination), destination);
                    return Object.freeze({
                        adapterId: selector.source.adapterId,
                        rootRole: selector.source.rootRole,
                        sourceDomain: selector.source.sourceDomain,
                        locatorIdentities: selector.source.locatorIdentities,
                        selectorFingerprint: selector.selectorFingerprint,
                    });
                });
                const tools = [...toolsByAdapter.entries()]
                    .map(([adapterId, agentRuntimeIds]) =>
                        Object.freeze({
                            adapterId,
                            displayName: providerNames.get(adapterId),
                            agentRuntimeIds: uniqueSorted(agentRuntimeIds),
                        }),
                    )
                    .sort((left, right) =>
                        compareDisplayText(left.displayName ?? left.adapterId, right.displayName ?? right.adapterId),
                    );
                const destinations = [...destinationsByKey.values()].sort((left, right) =>
                    compareDisplayText(destinationKey(left), destinationKey(right)),
                );
                return Object.freeze({
                    key: sourceLocationKey(entry.environment, canonicalPath),
                    environment: entry.environment,
                    canonicalPath,
                    tools: Object.freeze(tools),
                    claims: Object.freeze(claims),
                    destinations: Object.freeze(destinations),
                });
            });
        return Object.freeze({
            key: sourceEnvironmentKey(entry.environment),
            environment: entry.environment,
            sources: Object.freeze(sources),
        });
    });
    return Object.freeze(
        environments
            .filter((environment) => environment.sources.length > 0)
            .sort((left, right) => compareDisplayText(left.key, right.key)),
    );
}

export function filterSourceLibrary(
    environments: readonly SourceLibraryEnvironment[],
    search: string,
): readonly SourceLibraryEnvironment[] {
    const query = search.trim().toLocaleLowerCase("en-US");
    if (query === "") return environments;
    return Object.freeze(
        environments.flatMap((environment) => {
            const environmentMatches =
                environment.environment.platform.toLocaleLowerCase("en-US").includes(query) ||
                environment.environment.platformInstanceId.toLocaleLowerCase("en-US").includes(query);
            const sources = environment.sources.filter(
                (source) =>
                    environmentMatches ||
                    source.canonicalPath.toLocaleLowerCase("en-US").includes(query) ||
                    source.tools.some(
                        (tool) =>
                            tool.adapterId.toLocaleLowerCase("en-US").includes(query) ||
                            tool.displayName?.toLocaleLowerCase("en-US").includes(query) === true,
                    ),
            );
            return sources.length === 0 ? [] : [Object.freeze({ ...environment, sources: Object.freeze(sources) })];
        }),
    );
}

export function findSourceEnvironment(
    environments: readonly SourceLibraryEnvironment[],
    selection: ProtocolEnvironmentSelectorV1,
): SourceLibraryEnvironment | undefined {
    return environments.find(
        (environment) =>
            environment.environment.platform === selection.platform &&
            environment.environment.platformInstanceId === selection.platformInstanceId,
    );
}

export function findSourceLocation(
    environments: readonly SourceLibraryEnvironment[],
    selection: ProtocolEnvironmentSelectorV1,
    canonicalPath: string,
): SourceLibraryLocation | undefined {
    return findSourceEnvironment(environments, selection)?.sources.find((source) => source.canonicalPath === canonicalPath);
}
