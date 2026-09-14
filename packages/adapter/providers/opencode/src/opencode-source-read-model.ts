/** Shared OpenCode source-read model and family-owned dialect identifiers. */

import type {
    SourceCandidateBuilder,
    SourceCandidateBuildResult,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "@oaam/adapter-framework";
import type { FileReferenceV2, OperationDiagnostic, Platform, ReadEntryHandle } from "@oaam/core";

export const TOOL_DIALECT = "opencode-permission-selector-v1";
export const MODEL_DIALECT = "opencode-model-selector-v1";
export const VARIANT_DIALECT = "opencode-variant-selector-v1";
export const COLOR_DIALECT = "opencode-color-v1";
export const TURN_LIMIT_DIALECT = "opencode-steps-v1";

export const NATIVE_AGENT_NAMES = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"]);

export const OPENCODE_COLOR_NAMES = new Set(["primary", "secondary", "accent", "success", "warning", "error", "info"]);

export const CURRENT_AGENT_FRONTMATTER_KEYS = new Set([
    "model",
    "variant",
    "request",
    "system",
    "description",
    "mode",
    "hidden",
    "color",
    "steps",
    "disabled",
    "permissions",
]);

export const OPENCODE_NATIVE_DIALECTS = {
    guidance: "opencode-guidance-markdown-v1",
    instructionsRule: "opencode-instructions-config-graph-v1",
    commandWorkflow: "opencode-command-markdown-v1",
    skill: "opencode-skill-directory-v1",
    skillCli: "opencode-skill-directory-v2",
    subagent: "opencode-subagent-markdown-v1",
} as const;

export type OpencodeSkillInterpretation = 1 | 2;

export function opencodeSkillDialect(interpretation: OpencodeSkillInterpretation): string {
    return interpretation === 2 ? OPENCODE_NATIVE_DIALECTS.skillCli : OPENCODE_NATIVE_DIALECTS.skill;
}

export function opencodeSkillEntryDialect(interpretation: OpencodeSkillInterpretation): string {
    return interpretation === 2 ? "opencode-skill-markdown-v2" : "opencode-skill-markdown-v1";
}

export type SourceLayout = "config" | "project" | "skill_root" | "claude_guidance" | "external";

interface OpenCodeSourceContextExtension {
    platform: Platform;
    guidanceEnabled: boolean;
    projectConfigEnabled: boolean;
    externalSkillsEnabled: boolean;
    claudePromptEnabled: boolean;
    claudeSkillsEnabled: boolean;
}

export type SourceContext = SourceContextBase<SourceLayout, OpenCodeSourceContextExtension>;

export interface WorkflowReferenceClassification {
    references: FileReferenceV2[];
    diagnostics: OperationDiagnostic[];
    classificationHandles: ReadEntryHandle[];
}

export type FileRecord = SourceFileRecord;
export type DirectoryRecord = SourceDirectoryRecord;

interface OpenCodeScanResultExtension {
    unreadableRelativePaths: string[];
    workflowReferencesByPath: Map<string, WorkflowReferenceClassification>;
}

export type ScanResult = SourceScanResultBase<FileRecord, DirectoryRecord, OpenCodeScanResultExtension>;
export type CandidateBuildResult = SourceCandidateBuildResult;
export type CandidateBuilder = SourceCandidateBuilder<SourceContext, ScanResult>;
