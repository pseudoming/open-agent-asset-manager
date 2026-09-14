/** Exhaustive Codex source-reader dispositions. */

import { defineAssetReaderRegistry, sourceReader, sourceUnavailable, type AssetReaderDisposition } from "@oaam/adapter-framework";
import type { AssetKind } from "@oaam/core";
import { buildGuidanceCandidates } from "./codex-source-read-guidance";
import { buildMemoryCandidates } from "./codex-source-read-memory";
import { buildSkillCandidates } from "./codex-source-read-skill";
import { buildSubagentCandidates } from "./codex-source-read-subagent";
import { buildWorkflowCandidates } from "./codex-source-read-workflow";
import type { CodexCandidateBuilder } from "./codex-source-read-model";

export type CodexAssetReaderDisposition = AssetReaderDisposition<CodexCandidateBuilder>;

export const CODEX_ASSET_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildGuidanceCandidates),
    Rule: sourceUnavailable(
        "unsupported",
        "codex.rule_source_unsupported",
        "Codex .rules files are execution policy rather than OAAM Rule assets",
    ),
    Workflow: sourceReader(buildWorkflowCandidates),
    Skill: sourceReader(buildSkillCandidates),
    Subagent: sourceReader(buildSubagentCandidates),
    Memory: sourceReader(buildMemoryCandidates),
});

export function getCodexAssetReader(kind: AssetKind): CodexAssetReaderDisposition {
    return CODEX_ASSET_READER_REGISTRY[kind];
}
