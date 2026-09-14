/** Exhaustive Claude Code AssetKind source-reader registry. */

import {
    defineAssetReaderRegistry,
    sourceReader,
    type AssetReaderDisposition,
    type SourceReaderDisposition,
} from "@oaam/adapter-framework";
import type { AssetKind } from "@oaam/core";
import { buildGuidanceCandidates, buildRuleCandidates } from "./claudecode-source-read-guidance-rule";
import { buildMemoryCandidates } from "./claudecode-source-read-memory";
import type { CandidateBuilder } from "./claudecode-source-read-model";
import { buildSkillCandidates } from "./claudecode-source-read-skill";
import { buildSubagentCandidates } from "./claudecode-source-read-subagent";
import { buildWorkflowCandidates } from "./claudecode-source-read-workflow";

export type ClaudeCodeAssetReaderDisposition = AssetReaderDisposition<CandidateBuilder>;

export const CLAUDECODE_ASSET_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildGuidanceCandidates),
    Rule: sourceReader(buildRuleCandidates),
    Workflow: sourceReader(buildWorkflowCandidates),
    Skill: sourceReader(buildSkillCandidates),
    Subagent: sourceReader(buildSubagentCandidates),
    Memory: sourceReader(buildMemoryCandidates),
});

export function getClaudeCodeAssetReader(kind: AssetKind): SourceReaderDisposition<CandidateBuilder> {
    return CLAUDECODE_ASSET_READER_REGISTRY[kind];
}
