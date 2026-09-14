/** Exhaustive Antigravity AssetKind reader/disposition registry. */

import { defineAssetReaderRegistry, sourceReader, sourceUnavailable, type AssetReaderDisposition } from "@oaam/adapter-framework";
import type { AssetKind } from "@oaam/core";
import { buildGuidanceCandidates, buildRuleCandidates, buildWorkflowCandidates } from "./antigravity-source-read-markdown";
import type { CandidateBuilder } from "./antigravity-source-read-model";
import { buildSkillCandidates } from "./antigravity-source-read-skill";
import { buildSubagentCandidates } from "./antigravity-source-read-subagent";

export type AntigravityAssetReaderDisposition = AssetReaderDisposition<CandidateBuilder>;

export const ANTIGRAVITY_ASSET_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildGuidanceCandidates),
    Rule: sourceReader(buildRuleCandidates),
    Workflow: sourceReader(buildWorkflowCandidates),
    Skill: sourceReader(buildSkillCandidates),
    Subagent: sourceReader(buildSubagentCandidates),
    Memory: sourceUnavailable(
        "unsupported",
        "antigravity.memory_source_unsupported",
        "Antigravity has no native Memory source contract",
    ),
});

export function getAntigravityAssetReader(kind: AssetKind): AntigravityAssetReaderDisposition {
    return ANTIGRAVITY_ASSET_READER_REGISTRY[kind];
}
