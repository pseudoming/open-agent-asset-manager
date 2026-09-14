import { useState } from "react";
import { defaultDiscoveryReadSourceKeys, type DiscoverySourceClaimGroup } from "./discovery-model";

export function useDiscoverySourceSelection(probeToken: string | undefined, groups: readonly DiscoverySourceClaimGroup[]) {
    const [selection, setSelection] = useState<{
        probeToken: string | undefined;
        selectedSourceKeys: readonly string[];
        readAgentRuntimeIdsBySource: ReadonlyMap<string, string>;
    }>();
    const current =
        selection?.probeToken === probeToken && selection !== undefined
            ? selection
            : {
                  probeToken,
                  selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                  readAgentRuntimeIdsBySource: new Map<string, string>(),
              };
    return {
        selectedSourceKeys: current.selectedSourceKeys,
        readAgentRuntimeIdsBySource: current.readAgentRuntimeIdsBySource,
        onSelectedSourceKeysChange: (keys: readonly string[]) => setSelection({ ...current, selectedSourceKeys: keys }),
        onReadAgentRuntimeIdChange: (sourceKey: string, agentRuntimeId: string | undefined) => {
            const choices = new Map(current.readAgentRuntimeIdsBySource);
            if (agentRuntimeId === undefined) choices.delete(sourceKey);
            else choices.set(sourceKey, agentRuntimeId);
            setSelection({ ...current, readAgentRuntimeIdsBySource: choices });
        },
    };
}
