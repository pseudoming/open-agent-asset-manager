/** Internal source-read records shared by Antigravity reader responsibilities. */

import type {
    SourceCandidateBuilder,
    SourceCandidateBuildResult,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "@oaam/adapter-framework";

export const ANTIGRAVITY_NATIVE_DIALECTS = {
    guidance: "antigravity-guidance-markdown-v1",
    rule: "antigravity-rule-markdown-v1",
    workflow: "antigravity-workflow-markdown-v1",
    skillFolder: "antigravity-skill-folder-v1",
    skillFlat: "antigravity-skill-flat-v1",
    subagent: "antigravity-subagent-json-v1",
    subagentMarkdown: "antigravity-subagent-markdown-v1",
} as const;

export type SourceLayout = "config" | "skill_root" | "project" | "external";

export type SourceContext = SourceContextBase<SourceLayout>;
export type FileRecord = SourceFileRecord;
export type DirectoryRecord = SourceDirectoryRecord;
export type ScanResult = SourceScanResultBase<FileRecord, DirectoryRecord>;
export type CandidateBuildResult = SourceCandidateBuildResult;
export type CandidateBuilder = SourceCandidateBuilder<SourceContext, ScanResult>;
