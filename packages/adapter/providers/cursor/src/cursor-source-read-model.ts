/** Cursor source-read records and append-only native dialect identities. */

import type {
    SourceCandidateBuilder,
    SourceCandidateBuildResult,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "@oaam/adapter-framework";
import type { AgentRuntimeId } from "@oaam/core";

export const CURSOR_NATIVE_DIALECTS = {
    guidance: "cursor-guidance-markdown-v1",
    rule: "cursor-rule-mdc-v1",
    agentCommandWorkflow: "cursor-agent-command-markdown-v1",
    appCommandWorkflow: "cursor-app-command-document-v1",
    skill: "cursor-skill-directory-v1",
    subagent: "cursor-subagent-markdown-v1",
    memorySnapshot: "cursor-app-remote-memory-readonly-snapshot-v1",
} as const;

export type CursorSourceLayout = "project" | "config" | "skill_root" | "external" | "memory_snapshot";
export type CursorSourceContext = SourceContextBase<
    CursorSourceLayout,
    { agentRuntimeId: AgentRuntimeId; ownsSharedPhysicalSource: boolean }
>;
export type CursorFileRecord = SourceFileRecord;
export type CursorDirectoryRecord = SourceDirectoryRecord;
export type CursorScanResult = SourceScanResultBase<
    CursorFileRecord,
    CursorDirectoryRecord,
    { unreadableRelativePaths: string[]; unreadableDirectoryPaths: string[] }
>;
export type CursorCandidateBuildResult = SourceCandidateBuildResult;
export type CursorCandidateBuilder = SourceCandidateBuilder<CursorSourceContext, CursorScanResult>;
