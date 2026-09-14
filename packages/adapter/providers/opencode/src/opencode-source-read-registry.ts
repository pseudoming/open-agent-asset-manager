/** Exhaustive OpenCode AssetKind reader/disposition registry. */

import { defineAssetReaderRegistry, sourceReader, sourceUnavailable, type AssetReaderDisposition } from "@oaam/adapter-framework";
import type { AssetKind } from "@oaam/core";
import { buildGuidanceCandidates } from "./opencode-source-read-guidance";
import type { CandidateBuilder } from "./opencode-source-read-model";
import { buildSkillCandidates } from "./opencode-source-read-skill";
import { buildSubagentCandidates } from "./opencode-source-read-subagent";
import { buildWorkflowCandidates } from "./opencode-source-read-workflow";

export type OpencodeAssetReaderDisposition = AssetReaderDisposition<CandidateBuilder>;

export const OPENCODE_ASSET_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildGuidanceCandidates),
    Rule: sourceUnavailable(
        "unsupported",
        "opencode.rule_source_unsupported",
        "OpenCode instructions are Guidance references and permissions are execution policy; neither is a native Rule asset",
    ),
    Workflow: sourceReader(buildWorkflowCandidates),
    Skill: sourceReader(buildSkillCandidates),
    Subagent: sourceReader(buildSubagentCandidates),
    Memory: sourceUnavailable(
        "unsupported",
        "opencode.memory_source_unsupported",
        "OpenCode has no native Memory source contract",
    ),
});

export function getOpencodeAssetReader(kind: AssetKind): OpencodeAssetReaderDisposition {
    return OPENCODE_ASSET_READER_REGISTRY[kind];
}
