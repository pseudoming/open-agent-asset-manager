import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { AssetSpecHandler } from "./registry";
import { isAssetKindTypeDataV2 } from "./validators";

export const ruleSpecHandler = Object.freeze({
    kind: "Rule",
    isCanonicalPair: (value: unknown) => isAssetKindTypeDataV2(value) && value.kind === "Rule",
    completeEntryRule: () => "one_text",
    validateEntryText: (text: string) => text.trim().length > 0,
    validateFiles: () => [],
    collectDependencies: () => [],
    searchProjection: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Rule" }>).typeData;
        const activation = data.activation;
        return [data.name, data.description, ...(activation.mode === "path" ? activation.globs : [])];
    },
} satisfies AssetSpecHandler);
