/** Exhaustive Cursor source-reader dispositions. */

import { type AssetReaderDisposition, defineAssetReaderRegistry, sourceReader } from "@oaam/adapter-framework";
import type { AssetKind } from "@oaam/core";
import { buildCursorGuidanceCandidates, buildCursorRuleCandidates } from "./cursor-source-read-guidance-rule";
import { buildCursorMemoryCandidates } from "./cursor-source-read-memory";
import type { CursorCandidateBuilder } from "./cursor-source-read-model";
import { buildCursorSkillCandidates } from "./cursor-source-read-skill";
import { buildCursorSubagentCandidates } from "./cursor-source-read-subagent";
import { buildCursorWorkflowCandidates } from "./cursor-source-read-workflow";

export type CursorAssetReaderDisposition = AssetReaderDisposition<CursorCandidateBuilder>;

export const CURSOR_ASSET_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildCursorGuidanceCandidates),
    Rule: sourceReader(buildCursorRuleCandidates),
    Workflow: sourceReader(buildCursorWorkflowCandidates),
    Skill: sourceReader(buildCursorSkillCandidates),
    Subagent: sourceReader(buildCursorSubagentCandidates),
    Memory: sourceReader(buildCursorMemoryCandidates),
});

export function getCursorAssetReader(kind: AssetKind): CursorAssetReaderDisposition {
    return CURSOR_ASSET_READER_REGISTRY[kind];
}
