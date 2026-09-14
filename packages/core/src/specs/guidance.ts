import type { AssetSpecHandler } from "./registry";
import { isAssetKindTypeDataV2 } from "./validators";

export const guidanceSpecHandler = Object.freeze({
    kind: "Guidance",
    isCanonicalPair: (value: unknown) => isAssetKindTypeDataV2(value) && value.kind === "Guidance",
    completeEntryRule: () => "one_text",
    validateEntryText: (text: string) => text.trim().length > 0,
    validateFiles: () => [],
    collectDependencies: () => [],
    searchProjection: () => [],
} satisfies AssetSpecHandler);
