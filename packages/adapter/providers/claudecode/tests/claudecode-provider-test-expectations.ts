import type { AssetKind } from "@oaam/core";

export const KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];

export const EXPECTED_AGENT_RUNTIMES = [
    {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        displayName: "Claude Code CLI",
        entryClass: "cli",
    },
    {
        agentRuntimeId: "CLAUDE_CODE_APP",
        displayName: "Claude Code App",
        entryClass: "app",
    },
] as const;

export const APP_SOURCE_DIAGNOSTIC_CODES = {
    Guidance: "claudecode_app_guidance_source_unverified",
    Rule: "claudecode_app_rule_source_unverified",
    Workflow: "claudecode_app_workflow_source_unverified",
    Skill: "claudecode_app_skill_source_unverified",
    Subagent: "claudecode_app_subagent_source_unverified",
    Memory: "claudecode_app_memory_source_unverified",
} as const satisfies Readonly<Record<AssetKind, string>>;
