/** ZCode source-read records and immutable native dialect identifiers. */

import type {
    SourceCandidateBuilder,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "@oaam/adapter-framework";

export const ZCODE_NATIVE_DIALECTS = {
    guidance: "zcode-guidance-markdown-v1",
    commandWorkflow: "zcode-command-markdown-v1",
    scriptWorkflow: "zcode-script-workflow-javascript-v1",
    skill: "zcode-skill-directory-v1",
    subagent: "zcode-subagent-markdown-v1",
    memoryCatalog: "zcode-memory-catalog-v1",
    memoryTopic: "zcode-memory-topic-v1",
} as const;

export type ZcodeSourceLayout = "config" | "project" | "external" | "skill_root" | "command_root" | "agent_root" | "memory";
export type ZcodeSourceContext = SourceContextBase<ZcodeSourceLayout>;
export type ZcodeFileRecord = SourceFileRecord;
export type ZcodeScanResult = SourceScanResultBase<
    ZcodeFileRecord,
    SourceDirectoryRecord,
    { unreadableRelativePaths: string[]; unreadableDirectoryPaths: string[] }
>;
export type ZcodeCandidateBuilder = SourceCandidateBuilder<ZcodeSourceContext, ZcodeScanResult>;
