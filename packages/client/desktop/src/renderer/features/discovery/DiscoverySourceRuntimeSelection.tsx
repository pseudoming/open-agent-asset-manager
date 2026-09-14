import { useDesktopPresentation } from "../../presentation";
import { WorkbenchSelect } from "../../ui";
import type { AdapterProviderView, DiscoverySourceClaimGroup } from "./discovery-model";
import { presentDiscoveryAgentRuntime, presentDiscoveryTool } from "./discovery-presentation";

export function DiscoverySourceRuntimeSelection({
    group,
    providers,
    selectedSourceKeys,
    choices,
    busy,
    onChange,
}: {
    readonly group: DiscoverySourceClaimGroup;
    readonly providers: readonly AdapterProviderView[];
    readonly selectedSourceKeys: ReadonlySet<string>;
    readonly choices: ReadonlyMap<string, string>;
    readonly busy: boolean;
    readonly onChange: (sourceKey: string, agentRuntimeId: string | undefined) => void;
}): React.JSX.Element {
    const { text, displayText } = useDesktopPresentation();
    return (
        <div className="source-runtime-selection">
            {group.claims
                .filter(
                    ({ source }) =>
                        source.readSelection.status === "selectable" &&
                        source.agentRuntimeIds.length > 1 &&
                        selectedSourceKeys.has(source.key),
                )
                .map(({ source }) => (
                    <div key={source.key}>
                        <WorkbenchSelect
                            data-oaam-interaction-entry="features.discovery.source_runtime_selection.001"
                            label={text("discovery.product.source.read_entry", {
                                tool: displayText(presentDiscoveryTool(source.adapterId, providers).label),
                            })}
                            disabled={busy}
                            value={choices.get(source.key) ?? ""}
                            options={[
                                { value: "", label: text("discovery.product.source.read_all_entries") },
                                ...source.agentRuntimeIds.map((id) => ({
                                    value: id,
                                    label: displayText(presentDiscoveryAgentRuntime(id, providers).label),
                                })),
                            ]}
                            onChange={(value) => onChange(source.key, value === "" ? undefined : value)}
                        />
                        <small>{text("discovery.product.source.read_entry_help")}</small>
                    </div>
                ))}
        </div>
    );
}
