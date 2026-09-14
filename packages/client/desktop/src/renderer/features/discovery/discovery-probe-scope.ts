import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import type { DesktopApplicationClientApi } from "../../client";
import type { AdapterProviderView, EnvironmentListView } from "./discovery-model";

export interface DiscoveryProbeScope {
    readonly adapterIds: Parameters<DesktopApplicationClientApi["probeGlobal"]>[0];
    readonly environments: Parameters<DesktopApplicationClientApi["probeGlobal"]>[1];
}

export type DiscoveryProbeScopeResolution =
    | { readonly status: "ready"; readonly scope: DiscoveryProbeScope }
    | { readonly status: "no_provider" | "no_environment" };

export function resolveDiscoveryProbeScope(input: {
    readonly providers: readonly AdapterProviderView[];
    readonly environments: EnvironmentListView["environments"];
    readonly selectedAdapterIds: readonly string[];
    readonly selectedEnvironmentKeys: readonly string[];
}): DiscoveryProbeScopeResolution {
    const availableProviderIds = new Set(input.providers.map((provider) => provider.adapterId));
    const adapterIds = input.selectedAdapterIds.filter((adapterId) => availableProviderIds.has(adapterId));
    const firstAdapterId = adapterIds[0];
    if (firstAdapterId === undefined) return { status: "no_provider" };
    const selectedEnvironments = input.selectedEnvironmentKeys.flatMap((key) => {
        const selected = input.environments.find((environment) => desktopEnvironmentKey(environment.environment) === key);
        return selected === undefined ? [] : [selected.environment];
    });
    const firstEnvironment = selectedEnvironments[0];
    if (firstEnvironment === undefined) return { status: "no_environment" };
    return {
        status: "ready",
        scope: {
            adapterIds: [firstAdapterId, ...adapterIds.slice(1)],
            environments: [firstEnvironment, ...selectedEnvironments.slice(1)],
        },
    };
}
