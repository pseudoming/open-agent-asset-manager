import type { RenderAnalysisResult, SemanticRenderOption } from "../contracts/render";
import { compareUtf8Bytes } from "../foundation/text-order";

export interface AssetUsageObservationOptionMatch {
    readonly analysis: RenderAnalysisResult;
    readonly option: SemanticRenderOption;
}

/** Rank Provider-valid options for an approval-free, read-only target observation. */
export function chooseObservationMatch(
    matches: readonly AssetUsageObservationOptionMatch[],
): AssetUsageObservationOptionMatch | null {
    if (matches.length === 0) return null;
    return [...matches].sort((leftMatch, rightMatch) => {
        const left = leftMatch.option;
        const right = rightMatch.option;
        const outcome = Number(left.outcome === "degraded") - Number(right.outcome === "degraded");
        if (outcome !== 0) return outcome;
        const loss =
            (left.outcome === "degraded" ? left.degradationKinds.length : 0) -
            (right.outcome === "degraded" ? right.degradationKinds.length : 0);
        if (loss !== 0) return loss;
        const reverse =
            Number(left.actualReverseExtractPolicy === "unsupported") -
            Number(right.actualReverseExtractPolicy === "unsupported");
        return reverse || compareUtf8Bytes(left.optionFingerprint, right.optionFingerprint);
    })[0] as AssetUsageObservationOptionMatch;
}
