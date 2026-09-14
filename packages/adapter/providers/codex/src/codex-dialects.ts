/** Immutable Codex native dialect registrations. */

import type {
    AdapterDialectContractSetV1,
    PortableEntryDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableSelectorDialectUseV1,
} from "@oaam/core";
import {
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1,
} from "@oaam/adapter-framework";
import { CODEX_EFFORT_DIALECT, CODEX_MODEL_DIALECT, CODEX_NATIVE_DIALECTS } from "./codex-source-read-model";
import { validateCodexNativeDialect } from "./codex-source-read-native";
import { CODEX_EXACT_TARGET_COMPONENTS } from "./codex-target-exact-file";
import { CODEX_SKILL_GRAPH_REBASE_MATERIALIZER, CODEX_SKILL_GRAPH_TARGET_COMPONENTS } from "./codex-target-exact-graph";
import { CODEX_WORKFLOW_MIGRATION_COMPONENTS, validateCodexWorkflowAsSkillDialect } from "./codex-target-workflow-migration";

/**
 * Dialect IDs are append-only. File graph, schema, normalization, canonical
 * mapping, or validator changes require a new ID while this validator remains.
 */
export const CODEX_DIALECT_CONTRACTS: AdapterDialectContractSetV1 = {
    native: [
        defineNativeDialectContractV1({
            kind: "Guidance",
            dialectId: CODEX_NATIVE_DIALECTS.guidance,
            validateSameContent: validateCodexNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Skill",
            dialectId: CODEX_NATIVE_DIALECTS.skill,
            rebaseMaterializer: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
            rebase: CODEX_SKILL_GRAPH_REBASE_MATERIALIZER,
            validateSameContent: validateCodexNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Subagent",
            dialectId: CODEX_NATIVE_DIALECTS.subagentLegacy,
            validateSameContent: validateCodexNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Subagent",
            dialectId: CODEX_NATIVE_DIALECTS.subagent,
            rebaseMaterializer: CODEX_EXACT_TARGET_COMPONENTS.Subagent.rebase,
            validateSameContent: validateCodexNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Workflow",
            dialectId: CODEX_NATIVE_DIALECTS.workflow,
            validateSameContent: validateCodexNativeDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Workflow",
            dialectId: CODEX_NATIVE_DIALECTS.workflowAsSkill,
            rebaseMaterializer: CODEX_WORKFLOW_MIGRATION_COMPONENTS.rebase,
            validateSameContent: validateCodexWorkflowAsSkillDialect,
        }),
        defineNativeDialectContractV1({
            kind: "Memory",
            dialectId: CODEX_NATIVE_DIALECTS.memory,
            validateSameContent: validateCodexNativeDialect,
        }),
    ],
    restoration: [],
    portableEntries: [
        definePortableEntryDialectContractV1({
            kind: "Skill",
            field: "skill_entry",
            dialectId: "codex-skill-markdown-v1",
            applicableAgentRuntimeIds: ["CODEX_APP", "CODEX_CLI"],
            validateCanonicalEntry: validateSkillEntry,
            validateSourceApplicability: supportsCodexSource,
        }),
        definePortableEntryDialectContractV1({
            kind: "Workflow",
            field: "workflow_instruction",
            dialectId: CODEX_NATIVE_DIALECTS.workflow,
            applicableAgentRuntimeIds: ["CODEX_CLI"],
            validateCanonicalEntry: validateWorkflowEntry,
            validateSourceApplicability: supportsCodexCliSource,
        }),
    ],
    portableSelectors: [
        definePortableSelectorDialectContractV1({
            kind: "Subagent",
            field: "subagent_model",
            dialectId: CODEX_MODEL_DIALECT,
            applicableAgentRuntimeIds: ["CODEX_APP", "CODEX_CLI"],
            validateSelector: validateUnknownTierSelector,
            validateSourceApplicability: supportsCodexSource,
        }),
        definePortableSelectorDialectContractV1({
            kind: "Subagent",
            field: "subagent_effort",
            dialectId: CODEX_EFFORT_DIALECT,
            applicableAgentRuntimeIds: ["CODEX_APP", "CODEX_CLI"],
            validateSelector: validateUnknownTierSelector,
            validateSourceApplicability: supportsCodexSource,
        }),
    ],
};

function validateSkillEntry(input: PortableEntryDialectValidationInputV1): boolean {
    return (
        input.use.kind === "Skill" &&
        input.use.field === "skill_entry" &&
        input.canonical.kind === "Skill" &&
        input.canonical.typeData.entryDialectId === input.use.dialectId &&
        (input.versionStatus === "incomplete" || hasCanonicalTextEntryV1(input.canonicalFiles, input.use.logicalPath))
    );
}

function supportsCodexSource(source: PortableDialectSourceRuntimeV1): boolean {
    return source.agentRuntimeId === "CODEX_CLI" || source.agentRuntimeId === "CODEX_APP";
}

function supportsCodexCliSource(source: PortableDialectSourceRuntimeV1): boolean {
    return source.agentRuntimeId === "CODEX_CLI";
}

function validateWorkflowEntry(input: PortableEntryDialectValidationInputV1): boolean {
    return (
        input.use.kind === "Workflow" &&
        input.use.field === "workflow_instruction" &&
        input.canonical.kind === "Workflow" &&
        input.canonical.typeData.implementation.kind === "instructions" &&
        input.canonical.typeData.implementation.instructionDialectId === input.use.dialectId &&
        (input.versionStatus === "incomplete" || hasCanonicalTextEntryV1(input.canonicalFiles, input.use.logicalPath))
    );
}

function validateUnknownTierSelector(use: PortableSelectorDialectUseV1): boolean {
    return use.value.valueKind === "relative_tier" && use.value.selector.trim() !== "" && use.value.relativeTier === -1;
}
