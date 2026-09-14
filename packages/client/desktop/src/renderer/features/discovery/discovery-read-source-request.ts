import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import type { DiscoverySourceView, ProbeReviewView } from "./discovery-model";

/** Keep root groups with different explicitly chosen interpretations separate in the request. */
export function buildReadSourceRequest(
    probe: ProbeReviewView,
    sources: readonly DiscoverySourceView[],
    selectedKeys: ReadonlySet<string>,
    agentRuntimeIdsBySource: ReadonlyMap<string, string> = new Map(),
): ProtocolOperationParams<"adapter.read"> | undefined {
    const grouped = new Map<string, { probeResultRowId: string; agentRuntimeId?: string; roots: Set<string> }>();
    for (const source of sources) {
        if (!selectedKeys.has(source.key) || source.readSelection.status !== "selectable") continue;
        const agentRuntimeId = agentRuntimeIdsBySource.get(source.key);
        if (agentRuntimeId !== undefined && !source.agentRuntimeIds.includes(agentRuntimeId)) return undefined;
        const probeResultRowId = source.readSelection.probeResultRowId;
        const key = JSON.stringify([probeResultRowId, agentRuntimeId ?? null]);
        const group = grouped.get(key) ?? {
            probeResultRowId,
            ...(agentRuntimeId === undefined ? {} : { agentRuntimeId }),
            roots: new Set<string>(),
        };
        group.roots.add(source.readSelection.sourceRootRowId);
        grouped.set(key, group);
    }
    const selections = [...grouped]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, group]) => {
            const [first, ...remaining] = [...group.roots].sort();
            if (first === undefined) throw new TypeError("selected probe result has no source root rows");
            return {
                probeResultRowId: group.probeResultRowId,
                sourceRootRowIds: [first, ...remaining] as const,
                ...(group.agentRuntimeId === undefined ? {} : { agentRuntimeIds: [group.agentRuntimeId] as const }),
            };
        });
    const first = selections[0];
    return first === undefined ? undefined : { probeToken: probe.probeToken, selections: [first, ...selections.slice(1)] };
}
