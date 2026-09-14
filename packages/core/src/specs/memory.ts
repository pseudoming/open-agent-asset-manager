import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { AssetSpecHandler, SpecDependencyRequirement } from "./registry";
import { isAssetKindTypeDataV2 } from "./validators";

export const memorySpecHandler = Object.freeze({
    kind: "Memory",
    isCanonicalPair: (value: unknown) => isAssetKindTypeDataV2(value) && value.kind === "Memory",
    completeEntryRule: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Memory" }>).typeData;
        return data.entityRole === "catalog" ? "zero" : "one_text";
    },
    validateEntryText: (text: string) => text.trim().length > 0,
    validateFiles: () => [],
    collectDependencies: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Memory" }>).typeData;
        if (data.entityRole !== "catalog") return [];
        return data.members.map(
            (member) =>
                ({
                    targetAssetVersionId: member.targetAssetVersionId,
                    expectedTarget: "MemoryUnit",
                    scopeRequirement: "same_asset_scope",
                    source: "typeData.members",
                }) satisfies SpecDependencyRequirement,
        );
    },
    searchProjection: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Memory" }>).typeData;
        return data.entityRole === "unit"
            ? [data.card.name, data.card.description, data.applicabilityRule]
            : data.members.flatMap((member) => [member.routingTitle, member.routingHint]);
    },
} satisfies AssetSpecHandler);
