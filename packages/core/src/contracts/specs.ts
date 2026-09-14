import type { ToolSelectorV1 } from "./common";
import type { PosixRelativePath, UuidV4 } from "./primitives";

export interface GuidanceTypeDataV1 {
    schemaVersion: 1;
}

export type RuleActivationV2 =
    | { mode: "always" }
    | { mode: "manual" }
    | { mode: "path"; globs: string[] }
    | { mode: "model_decision" };

export interface RuleTypeDataV2 {
    schemaVersion: 2;
    name: string;
    description: string;
    activation: RuleActivationV2;
}

/** Provider-owned, versioned instruction format identity. */
export type WorkflowInstructionDialectIdV1 = string;

export type WorkflowRelativeTierV1 = -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type WorkflowModelSelectionV1 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: WorkflowRelativeTierV1;
      };

export type WorkflowEffortSelectionV1 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: WorkflowRelativeTierV1;
      };

export type WorkflowInstructionShellV1 =
    | { mode: "none" }
    | { mode: "agent_runtime_default" }
    | { mode: "selected"; dialectId: string; selector: string };

export interface WorkflowInvocationV2 {
    commandNames: string[];
    userInvocable: boolean;
    agentInvocable: boolean;
    argumentHint: string;
    argumentNames: string[];
}

export interface WorkflowToolPolicyV2 {
    preapproved: ToolSelectorV1[];
    denied: ToolSelectorV1[];
    otherwise: "inherit_agent_runtime_policy";
}

export type WorkflowInstructionAgentSelectionV2 =
    | { mode: "agent_runtime_default" }
    | { mode: "agent_runtime_named"; selector: string }
    | { mode: "bound"; targetAssetVersionId: UuidV4 };

export interface WorkflowInstructionExecutionV2 {
    mode: "caller" | "isolated";
    agent: WorkflowInstructionAgentSelectionV2;
    model: WorkflowModelSelectionV1;
    effort: WorkflowEffortSelectionV1;
    shell: WorkflowInstructionShellV1;
}

export type WorkflowImplementationV2 =
    | {
          kind: "instructions";
          instructionDialectId: WorkflowInstructionDialectIdV1;
          execution: WorkflowInstructionExecutionV2;
          toolPolicy: WorkflowToolPolicyV2;
      }
    | {
          kind: "executable";
          executableDialectId: string;
      };

export interface WorkflowTypeDataV2 {
    schemaVersion: 2;
    name: string;
    description: string;
    implementation: WorkflowImplementationV2;
    invocation: WorkflowInvocationV2;
}

export type SkillPathConditionV2 = { mode: "none" } | { mode: "required"; patterns: string[] };

export type SkillUserInvocationV2 = { mode: "not_directly_invocable" } | { mode: "direct"; commandName: string };

export type SkillModelInvocationV2 = { mode: "disabled" } | { mode: "model_decision" };

export interface SkillInvocationV2 {
    pathCondition: SkillPathConditionV2;
    user: SkillUserInvocationV2;
    model: SkillModelInvocationV2;
    argumentHint: string;
    argumentNames: string[];
}

export interface SkillToolPolicyV2 {
    preapproved: ToolSelectorV1[];
    denied: ToolSelectorV1[];
    otherwise: "inherit_agent_runtime_policy";
}

export type SkillExecutionAgentSelectionV2 =
    | { mode: "agent_runtime_default" }
    | { mode: "agent_runtime_named"; dialectId: string; selector: string }
    | { mode: "bound"; targetAssetVersionId: UuidV4 };

export type SkillRelativeTierV1 = -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type SkillModelSelectionV1 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: SkillRelativeTierV1;
      };

export type SkillEffortSelectionV1 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: SkillRelativeTierV1;
      };

export type SkillExecutionV2 =
    | {
          mode: "caller";
          model: SkillModelSelectionV1;
          effort: SkillEffortSelectionV1;
      }
    | {
          mode: "isolated";
          agent: SkillExecutionAgentSelectionV2;
          model: SkillModelSelectionV1;
          effort: SkillEffortSelectionV1;
      };

export interface SkillPortableMetadataV2 {
    license: string;
    compatibility: string;
    metadata: Record<string, string>;
}

/** Provider-owned, versioned Skill entry format identity. */
export type SkillEntryDialectIdV1 = string;

export interface SkillTypeDataV2 {
    schemaVersion: 2;
    name: string;
    description: string;
    whenToUse: string;
    entryDialectId: SkillEntryDialectIdV1;
    portableMetadata: SkillPortableMetadataV2;
    invocation: SkillInvocationV2;
    toolPolicy: SkillToolPolicyV2;
    execution: SkillExecutionV2;
}

export interface SubagentInstructionEntryV1 {
    schemaVersion: 1;
    sections: Array<{ title: string; content: string }>;
}

export type SubagentPromptContextPolicyV2 =
    | { mode: "agent_runtime_default" }
    | { mode: "selected"; dialectId: string; selectors: string[] };

export type SubagentToolSelectorV2 =
    | { mode: "agent_runtime_tool"; selector: ToolSelectorV1 }
    | { mode: "bound_subagent"; targetAssetVersionId: UuidV4 };

export type SubagentAvailableToolsV2 =
    | { mode: "inherit_available" }
    | { mode: "none" }
    | { mode: "allowlist"; allowed: SubagentToolSelectorV2[] };

export interface SubagentToolAvailabilityV2 {
    base: SubagentAvailableToolsV2;
    unavailable: SubagentToolSelectorV2[];
}

export type SubagentToolPermissionActionV2 = "preapproved" | "ask" | "deny";

export interface SubagentToolPermissionRuleV2 {
    selector: SubagentToolSelectorV2;
    action: SubagentToolPermissionActionV2;
}

export interface SubagentToolPermissionPolicyV2 {
    rules: SubagentToolPermissionRuleV2[];
    otherwise: "inherit_agent_runtime_policy";
}

export interface SubagentToolAuthorityV2 {
    availability: SubagentToolAvailabilityV2;
    permission: SubagentToolPermissionPolicyV2;
}

export type SubagentPermissionEffectV1 =
    | "interactive"
    | "read_only"
    | "auto_approve_selected_operations"
    | "auto_deny_unapproved"
    | "bypass_permission_checks"
    | "classifier_mediated";

export type SubagentPermissionPolicyV2 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          effect: SubagentPermissionEffectV1;
      };

export type SubagentMemoryPolicyV2 =
    | { mode: "disabled" }
    | {
          mode: "persistent";
          storageScope: "global" | "project_shared" | "project_local";
      };

export interface SubagentDependenciesV2 {
    preloadedSkillVersionIds: UuidV4[];
}

export type SubagentRelativeTierV1 = -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type SubagentModelSelectionV1 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: SubagentRelativeTierV1;
      };

export type SubagentEffortSelectionV1 =
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: SubagentRelativeTierV1;
      };

export type SubagentWorkspaceIsolationV2 = { mode: "agent_runtime_default" } | { mode: "isolated_worktree" };

export type SubagentSchedulingV2 =
    | { mode: "agent_runtime_default" }
    | { mode: "always_foreground" }
    | { mode: "always_background" };

export type SubagentTurnLimitV2 = { mode: "agent_runtime_default" } | { mode: "bounded"; dialectId: string; limit: number };

export type SubagentSamplingValueV2 = { mode: "agent_runtime_default" } | { mode: "selected"; value: number };

export interface SubagentSamplingV2 {
    temperature: SubagentSamplingValueV2;
    topP: SubagentSamplingValueV2;
}

export interface SubagentExecutionV2 {
    permission: SubagentPermissionPolicyV2;
    workspaceIsolation: SubagentWorkspaceIsolationV2;
    scheduling: SubagentSchedulingV2;
    turnLimit: SubagentTurnLimitV2;
    model: SubagentModelSelectionV1;
    effort: SubagentEffortSelectionV1;
    sampling: SubagentSamplingV2;
}

export type SubagentColorHintV2 = { mode: "agent_runtime_default" } | { mode: "selected"; dialectId: string; selector: string };

export interface SubagentPresentationV2 {
    listing: "agent_runtime_default" | "visible" | "hidden";
    color: SubagentColorHintV2;
}

export type SubagentDirectInitialPromptV1 =
    | { mode: "none" }
    | {
          mode: "resource";
          logicalPath: PosixRelativePath;
          dialectId: string;
      };

export type SubagentDirectInvocationV2 =
    | { mode: "agent_runtime_default" }
    | { mode: "delegated_only" }
    | { mode: "user_selectable"; initialPrompt: SubagentDirectInitialPromptV1 };

export interface SubagentTypeDataV2 {
    schemaVersion: 2;
    name: string;
    description: string;
    promptContextPolicy: SubagentPromptContextPolicyV2;
    tools: SubagentToolAuthorityV2;
    dependencies: SubagentDependenciesV2;
    memory: SubagentMemoryPolicyV2;
    execution: SubagentExecutionV2;
    directInvocation: SubagentDirectInvocationV2;
    presentation: SubagentPresentationV2;
}

export interface MemoryUnitTypeDataV2 {
    schemaVersion: 2;
    entityRole: "unit";
    card: { name: string; description: string };
    loading: { card: "high"; body: "low" };
    applicabilityRule: string;
}

export interface MemoryCatalogMemberV2 {
    targetAssetVersionId: UuidV4;
    routingTitle: string;
    routingHint: string;
}

export interface MemoryCatalogTypeDataV2 {
    schemaVersion: 2;
    entityRole: "catalog";
    members: MemoryCatalogMemberV2[];
}

export type MemoryTypeDataV2 = MemoryUnitTypeDataV2 | MemoryCatalogTypeDataV2;

export type AssetKindTypeDataV2 =
    | { kind: "Guidance"; typeData: GuidanceTypeDataV1 }
    | { kind: "Rule"; typeData: RuleTypeDataV2 }
    | { kind: "Workflow"; typeData: WorkflowTypeDataV2 }
    | { kind: "Skill"; typeData: SkillTypeDataV2 }
    | { kind: "Subagent"; typeData: SubagentTypeDataV2 }
    | { kind: "Memory"; typeData: MemoryTypeDataV2 };

export type AssetTypeDataCurrent = AssetKindTypeDataV2["typeData"];
