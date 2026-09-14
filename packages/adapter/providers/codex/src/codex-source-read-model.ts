/** Codex source-read records and immutable native dialect identifiers. */

import type {
    SourceCandidateBuilder,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "@oaam/adapter-framework";

export const CODEX_NATIVE_DIALECTS = {
    guidance: "codex-guidance-markdown-v1",
    skill: "codex-skill-directory-v1",
    subagentLegacy: "codex-subagent-toml-v1",
    subagent: "codex-subagent-toml-v2",
    workflow: "codex-custom-prompt-markdown-v1",
    workflowAsSkill: "codex-workflow-as-skill-v1",
    memory: "codex-consolidated-memory-v1",
} as const;

export const CODEX_MODEL_DIALECT = "codex-subagent-model-v1";
export const CODEX_EFFORT_DIALECT = "codex-subagent-reasoning-effort-v1";

export type CodexSourceLayout = "config" | "memory" | "project" | "skill_root";

interface CodexSourceContextExtension {
    fallbackConfigurationKnown: boolean;
    fallbackFilenames: string[];
}

interface CodexScanResultExtension {
    unreadableRelativePaths: string[];
}

export type CodexSourceContext = SourceContextBase<CodexSourceLayout, CodexSourceContextExtension>;
export type CodexFileRecord = SourceFileRecord;
export type CodexScanResult = SourceScanResultBase<CodexFileRecord, SourceDirectoryRecord, CodexScanResultExtension>;
export type CodexCandidateBuilder = SourceCandidateBuilder<CodexSourceContext, CodexScanResult>;
