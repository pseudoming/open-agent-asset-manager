/** Exhaustive ZCode source-reader dispositions. */

import { defineAssetReaderRegistry, sourceReader, sourceUnavailable, type AssetReaderDisposition } from "@oaam/adapter-framework";
import type { AssetKind } from "@oaam/core";
import { buildGuidanceCandidates } from "./zcode-source-read-guidance";
import { buildMemoryCandidates } from "./zcode-source-read-memory";
import { buildSkillCandidates } from "./zcode-source-read-skill";
import { buildSubagentCandidates } from "./zcode-source-read-subagent";
import { buildWorkflowCandidates } from "./zcode-source-read-workflow";
import type { ZcodeCandidateBuilder } from "./zcode-source-read-model";

export type ZcodeAssetReaderDisposition = AssetReaderDisposition<ZcodeCandidateBuilder>;

export const ZCODE_ASSET_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildGuidanceCandidates),
    Rule: sourceUnavailable("unsupported", "zcode.rule_source_unsupported", "ZCode exposes no independent Rule source mechanism"),
    Workflow: sourceReader(buildWorkflowCandidates),
    Skill: sourceReader(buildSkillCandidates),
    Subagent: sourceReader(buildSubagentCandidates),
    Memory: sourceReader(buildMemoryCandidates),
});

export function getZcodeAssetReader(kind: AssetKind): ZcodeAssetReaderDisposition {
    return ZCODE_ASSET_READER_REGISTRY[kind];
}
