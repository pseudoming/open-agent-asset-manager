/** Immutable Cursor native dialect registrations. */

import {
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1,
} from "@oaam/adapter-framework";
import type {
    AdapterDialectContractSetV1,
    AdapterPortableEntryDialectContractV1,
    AgentRuntimeId,
    PortableEntryDialectValidationInputV1,
    PortableSelectorDialectUseV1,
} from "@oaam/core";
import { CURSOR_NATIVE_DIALECTS } from "./cursor-source-read-model";
import { validateCursorNativeDialect } from "./cursor-source-read-native";
import {
    CURSOR_SUBAGENT_MODEL_DIALECT,
    CURSOR_SUBAGENT_PERMISSION_DIALECT,
    CURSOR_SUBAGENT_TOOL_DIALECT,
    isCursorSubagentToolName,
} from "./cursor-subagent-markdown";
import { CURSOR_RULE_TARGET_COMPONENTS } from "./cursor-target-rule";
import { CURSOR_SKILL_REBASE_MATERIALIZER, CURSOR_SKILL_TARGET_COMPONENTS } from "./cursor-target-skill";
import { CURSOR_SUBAGENT_TARGET_COMPONENTS } from "./cursor-target-subagent";
import { CURSOR_WORKFLOW_TARGET_COMPONENTS } from "./cursor-target-workflow";

export const CURSOR_DIALECT_CONTRACTS: AdapterDialectContractSetV1 = {
    native: [
        defineNativeDialectContractV1({
            kind: "Guidance",
            dialectId: CURSOR_NATIVE_DIALECTS.guidance,
            validateSameContent: validateCursorNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Skill",
            dialectId: CURSOR_NATIVE_DIALECTS.skill,
            rebaseMaterializer: CURSOR_SKILL_TARGET_COMPONENTS.rebase,
            rebase: CURSOR_SKILL_REBASE_MATERIALIZER,
            validateSameContent: validateCursorNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Rule",
            dialectId: CURSOR_NATIVE_DIALECTS.rule,
            rebaseMaterializer: CURSOR_RULE_TARGET_COMPONENTS.rebase,
            validateSameContent: validateCursorNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Workflow",
            dialectId: CURSOR_NATIVE_DIALECTS.agentCommandWorkflow,
            rebaseMaterializer: CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase,
            validateSameContent: validateCursorNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Subagent",
            dialectId: CURSOR_NATIVE_DIALECTS.subagent,
            rebaseMaterializer: CURSOR_SUBAGENT_TARGET_COMPONENTS.rebase,
            validateSameContent: validateCursorNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Workflow",
            dialectId: CURSOR_NATIVE_DIALECTS.appCommandWorkflow,
            rebaseMaterializer: CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase,
            validateSameContent: validateCursorNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Memory",
            dialectId: CURSOR_NATIVE_DIALECTS.memorySnapshot,
            validateSameContent: validateCursorNativeDialect,
        }),
    ],
    restoration: [],
    portableEntries: [
        definePortableEntryDialectContractV1({
            kind: "Skill",
            field: "skill_entry",
            dialectId: CURSOR_NATIVE_DIALECTS.skill,
            applicableAgentRuntimeIds: ["CURSOR_AGENT_CLI", "CURSOR_APP"],
            validateCanonicalEntry: validateSkillEntry,
            validateSourceApplicability: (source) =>
                source.agentRuntimeId === "CURSOR_AGENT_CLI" || source.agentRuntimeId === "CURSOR_APP",
        }),
        workflowEntry(CURSOR_NATIVE_DIALECTS.agentCommandWorkflow, "CURSOR_AGENT_CLI"),
        workflowEntry(CURSOR_NATIVE_DIALECTS.appCommandWorkflow, "CURSOR_APP"),
    ],
    portableSelectors: [
        selector("subagent_tool", CURSOR_SUBAGENT_TOOL_DIALECT),
        selector("subagent_model", CURSOR_SUBAGENT_MODEL_DIALECT),
        selector("subagent_permission", CURSOR_SUBAGENT_PERMISSION_DIALECT),
    ],
};

function selector(field: "subagent_tool" | "subagent_model" | "subagent_permission", dialectId: string) {
    return definePortableSelectorDialectContractV1({
        kind: "Subagent",
        field,
        dialectId,
        applicableAgentRuntimeIds: ["CURSOR_AGENT_CLI", "CURSOR_APP"],
        validateSelector: validateSubagentSelector,
        validateSourceApplicability: (source) =>
            source.agentRuntimeId === "CURSOR_AGENT_CLI" || source.agentRuntimeId === "CURSOR_APP",
    });
}

function validateSubagentSelector(use: PortableSelectorDialectUseV1): boolean {
    if (use.kind !== "Subagent") return false;
    if (use.field === "subagent_tool") {
        return use.value.valueKind === "selector" && isCursorSubagentToolName(use.value.selector);
    }
    if (use.field === "subagent_model") {
        return use.value.valueKind === "relative_tier" && use.value.selector.trim() !== "" && use.value.relativeTier === -1;
    }
    return (
        use.field === "subagent_permission" &&
        use.value.valueKind === "permission_effect" &&
        use.value.selector === "readonly" &&
        use.value.effect === "read_only"
    );
}

function validateSkillEntry(input: PortableEntryDialectValidationInputV1): boolean {
    return (
        input.use.kind === "Skill" &&
        input.use.field === "skill_entry" &&
        input.canonical.kind === "Skill" &&
        input.canonical.typeData.entryDialectId === input.use.dialectId &&
        (input.versionStatus === "incomplete" || hasCanonicalTextEntryV1(input.canonicalFiles, input.use.logicalPath))
    );
}

function workflowEntry(dialectId: string, agentRuntimeId: AgentRuntimeId): AdapterPortableEntryDialectContractV1 {
    return definePortableEntryDialectContractV1({
        kind: "Workflow",
        field: "workflow_instruction",
        dialectId,
        applicableAgentRuntimeIds: [agentRuntimeId],
        validateCanonicalEntry: (input) => validateWorkflowEntry(input, dialectId),
        validateSourceApplicability: (source) => source.agentRuntimeId === agentRuntimeId,
    });
}

function validateWorkflowEntry(input: PortableEntryDialectValidationInputV1, dialectId: string): boolean {
    return (
        input.use.kind === "Workflow" &&
        input.use.field === "workflow_instruction" &&
        input.canonical.kind === "Workflow" &&
        input.canonical.typeData.implementation.kind === "instructions" &&
        input.canonical.typeData.implementation.instructionDialectId === dialectId &&
        (input.versionStatus === "incomplete" || hasCanonicalTextEntryV1(input.canonicalFiles, input.use.logicalPath))
    );
}
