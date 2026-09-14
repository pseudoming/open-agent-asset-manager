/** Explicit source interpretation selection narrows existing Provider/root ownership only. */
import type { AdapterProvider, AdapterReadTarget } from "../types";

export function isValidReadAgentRuntimeSelection(
    provider: Pick<AdapterProvider, "agentRuntimes">,
    target: AdapterReadTarget,
): boolean {
    const selected = target.agentRuntimeIds;
    if (selected === undefined) return true;
    if (!Array.isArray(selected) || selected.length === 0 || new Set(selected).size !== selected.length) return false;
    const declared = new Set(provider.agentRuntimes.map((runtime) => runtime.agentRuntimeId));
    if (selected.some((id) => typeof id !== "string" || !declared.has(id))) return false;
    const selector = target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") return true;
    const roots = new Set(selector.sourceRootIds);
    const observed = new Set(
        selector.observation.observedAgentRuntimes
            .filter((runtime) => runtime.sourceRootIds.some((id) => roots.has(id)))
            .map((runtime) => runtime.agentRuntimeId),
    );
    return selected.every((id) => observed.has(id));
}
