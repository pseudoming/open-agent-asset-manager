/** Internal records and dialect identifiers for Claude Code source reads. */

import type {
    SourceCandidateBuilder,
    SourceCandidateBuildResult,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "@oaam/adapter-framework";

export const CLAUDECODE_NATIVE_DIALECTS = {
    guidance: "claudecode-guidance-markdown-v1",
    rule: "claudecode-rule-markdown-v1",
    commandWorkflow: "claudecode-command-markdown-v1",
    javascriptWorkflow: "claudecode-js-workflow-v1",
    skill: "claudecode-skill-directory-v1",
    subagent: "claudecode-subagent-markdown-v1",
    memoryCatalog: "claudecode-memory-catalog-v1",
    memoryTopic: "claudecode-memory-topic-v1",
} as const;

export type RelativeTier = -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type ClaudeSourceLayout = "config" | "project" | "memory";

export type SourceContext = SourceContextBase<ClaudeSourceLayout>;
export type FileRecord = SourceFileRecord;
export type DirectoryRecord = SourceDirectoryRecord;
export type ScanResult = SourceScanResultBase<FileRecord, DirectoryRecord>;
export type CandidateBuildResult = SourceCandidateBuildResult;
export type CandidateBuilder = SourceCandidateBuilder<SourceContext, ScanResult>;
