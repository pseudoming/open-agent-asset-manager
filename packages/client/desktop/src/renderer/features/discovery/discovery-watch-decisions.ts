import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import type { DiscoverySourceView, DiscoveryWatchBinding, DiscoveryWatchSelection } from "./discovery-model";

type WatchedReplaceDecision = ProtocolOperationParams<"watched_scan_intent.replace">["decisions"][number];

function sameBinding(left: DiscoveryWatchBinding | undefined, right: DiscoveryWatchBinding): boolean {
    return (
        left?.assetScope === right.assetScope &&
        (left.assetScope !== "project" || (right.assetScope === "project" && left.projectId === right.projectId))
    );
}

export function buildWatchedScanDecisions(
    probeToken: string,
    sources: readonly DiscoverySourceView[],
    selections: readonly DiscoveryWatchSelection[],
    explicitlyExcludedSourceKeys: readonly string[] = [],
): readonly WatchedReplaceDecision[] {
    const sourcesByKey = new Map(sources.map((source) => [source.key, source] as const));
    const selectedByKey = new Map<string, DiscoveryWatchBinding>();
    for (const selection of selections) {
        if (selectedByKey.has(selection.sourceKey) || !sourcesByKey.has(selection.sourceKey)) {
            throw new TypeError("watched source selection is duplicate or stale");
        }
        selectedByKey.set(selection.sourceKey, selection.binding);
    }
    const explicitlyExcluded = new Set(explicitlyExcludedSourceKeys);
    if (explicitlyExcluded.size !== explicitlyExcludedSourceKeys.length) {
        throw new TypeError("explicitly excluded watched source is duplicate");
    }
    for (const sourceKey of explicitlyExcluded) {
        const source = sourcesByKey.get(sourceKey);
        if (source?.watchAvailability.status !== "selectable" || selectedByKey.has(sourceKey)) {
            throw new TypeError("explicitly excluded watched source is stale, unavailable, or selected");
        }
    }
    const decisions: WatchedReplaceDecision[] = [];
    for (const source of sources) {
        if (source.watchAvailability.status !== "selectable") continue;
        const selectedBinding = selectedByKey.get(source.key);
        const { observed, prior } = source.watchAvailability;
        if (selectedBinding !== undefined) {
            if (
                prior?.disposition === "included" &&
                sameBinding(prior.binding, selectedBinding) &&
                (observed === undefined || source.status === "current")
            ) {
                decisions.push({ action: "retain_existing", selectorFingerprint: prior.selectorFingerprint });
                continue;
            }
            if (observed === undefined) throw new TypeError("missing watched source cannot change binding");
            const [firstAgentRuntimeId, ...remainingAgentRuntimeIds] = source.agentRuntimeIds;
            if (firstAgentRuntimeId === undefined) throw new TypeError("watchable source has no agent runtime");
            decisions.push({
                action: "include_observed",
                probeToken,
                probeResultRowId: observed.probeResultRowId,
                sourceRootRowId: observed.sourceRootRowId,
                agentRuntimeIds: [firstAgentRuntimeId, ...remainingAgentRuntimeIds],
                binding: selectedBinding,
            });
            continue;
        }
        if (observed !== undefined && (explicitlyExcluded.has(source.key) || prior?.disposition === "included")) {
            const [firstAgentRuntimeId, ...remainingAgentRuntimeIds] = source.agentRuntimeIds;
            if (firstAgentRuntimeId === undefined) throw new TypeError("watchable source has no agent runtime");
            decisions.push({
                action: "exclude_observed",
                probeToken,
                probeResultRowId: observed.probeResultRowId,
                sourceRootRowId: observed.sourceRootRowId,
                agentRuntimeIds: [firstAgentRuntimeId, ...remainingAgentRuntimeIds],
            });
        } else if (prior?.disposition === "excluded") {
            decisions.push({ action: "retain_existing", selectorFingerprint: prior.selectorFingerprint });
        }
    }
    return Object.freeze(decisions);
}
