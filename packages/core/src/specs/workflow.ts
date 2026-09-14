import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { AssetSpecHandler, SpecDependencyRequirement } from "./registry";
import { isAssetKindTypeDataV2 } from "./validators";

export const workflowSpecHandler = Object.freeze({
    kind: "Workflow",
    isCanonicalPair: (value: unknown) => isAssetKindTypeDataV2(value) && value.kind === "Workflow",
    completeEntryRule: () => "one_text",
    validateEntryText: (text: string) => text.trim().length > 0,
    validateFiles: () => [],
    collectDependencies: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Workflow" }>).typeData;
        if (data.implementation.kind !== "instructions" || data.implementation.execution.agent.mode !== "bound") {
            return [];
        }
        return [
            {
                targetAssetVersionId: data.implementation.execution.agent.targetAssetVersionId,
                expectedTarget: "Subagent",
                scopeRequirement: "none",
                source: "typeData.implementation.execution.agent",
            },
        ] satisfies SpecDependencyRequirement[];
    },
    searchProjection: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Workflow" }>).typeData;
        return [
            data.name,
            data.description,
            ...data.invocation.commandNames,
            data.invocation.argumentHint,
            ...data.invocation.argumentNames,
        ];
    },
} satisfies AssetSpecHandler);
