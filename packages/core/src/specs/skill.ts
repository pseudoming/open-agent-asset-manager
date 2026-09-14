import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { AssetSpecHandler, SpecDependencyRequirement } from "./registry";
import { isAssetKindTypeDataV2 } from "./validators";

export const skillSpecHandler = Object.freeze({
    kind: "Skill",
    isCanonicalPair: (value: unknown) => isAssetKindTypeDataV2(value) && value.kind === "Skill",
    completeEntryRule: () => "one_text",
    validateEntryText: (text: string) => text.trim().length > 0,
    validateFiles: () => [],
    collectDependencies: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Skill" }>).typeData;
        if (data.execution.mode !== "isolated" || data.execution.agent.mode !== "bound") {
            return [];
        }
        return [
            {
                targetAssetVersionId: data.execution.agent.targetAssetVersionId,
                expectedTarget: "Subagent",
                scopeRequirement: "none",
                source: "typeData.execution.agent",
            },
        ] satisfies SpecDependencyRequirement[];
    },
    searchProjection: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Skill" }>).typeData;
        return [
            data.name,
            data.description,
            data.whenToUse,
            data.portableMetadata.license,
            data.portableMetadata.compatibility,
            ...Object.values(data.portableMetadata.metadata),
        ];
    },
} satisfies AssetSpecHandler);
