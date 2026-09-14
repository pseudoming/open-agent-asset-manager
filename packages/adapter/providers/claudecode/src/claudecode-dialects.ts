/** Immutable Claude Code native/restoration dialect registrations. */

import type {
    AdapterDialectContractSetV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AdapterRestorationDialectContractV1,
    AssetKind,
    PortableEntryDialectFieldV1,
    PortableEntryDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    VersionedContractComponentRef,
} from "@oaam/core";
import {
    defineDialectComponentV1 as component,
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1 as entryExists,
} from "@oaam/adapter-framework";
import { CLAUDECODE_NATIVE_DIALECTS, validateClaudeCodeNativeDialect } from "./claudecode-source-read";
import {
    CLAUDECODE_COLOR_DIALECT,
    CLAUDECODE_EFFORT_DIALECT,
    CLAUDECODE_MODEL_DIALECT,
    CLAUDECODE_SHELL_DIALECT,
    CLAUDECODE_TURN_LIMIT_DIALECT,
    effortTier,
    isClaudeRuntimeNativeAgent,
    modelTier,
    permissionPolicy,
} from "./claudecode-source-read-fields";
import { CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS } from "./claudecode-target-encoded-subagent";
import { CLAUDECODE_EXACT_TARGET_COMPONENTS, parseClaudeMemoryTopicRestorationPayload } from "./claudecode-target-exact-file";
import {
    CLAUDECODE_SKILL_GRAPH_REBASE_MATERIALIZER,
    CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS,
    CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS,
} from "./claudecode-target-exact-graph";

const CLAUDE_RUNTIME_IDS = ["CLAUDE_CODE_APP", "CLAUDE_CODE_CLI"];
const TOOL_DIALECT = "claudecode-tool-selector-v1";
const PERMISSION_DIALECT = "claudecode-permission-mode-v1";
const SKILL_ENTRY_DIALECT = "claudecode-skill-markdown-v1";
const SKILL_AGENT_DIALECT = "claudecode-agent-name-v1";
const INITIAL_PROMPT_DIALECT = "claudecode-initial-prompt-v1";

const NATIVE_ROWS: ReadonlyArray<{
    kind: AssetKind;
    dialectId: string;
    rebaseMaterializer?: VersionedContractComponentRef;
}> = [
    { kind: "Guidance", dialectId: CLAUDECODE_NATIVE_DIALECTS.guidance },
    {
        kind: "Rule",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.rule,
        rebaseMaterializer: CLAUDECODE_EXACT_TARGET_COMPONENTS.Rule.rebase,
    },
    {
        kind: "Workflow",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
        rebaseMaterializer: CLAUDECODE_EXACT_TARGET_COMPONENTS.Workflow.rebase,
    },
    {
        kind: "Workflow",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
        rebaseMaterializer: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.rebase,
    },
    {
        kind: "Skill",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.skill,
        rebaseMaterializer: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
    },
    {
        kind: "Subagent",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.subagent,
        rebaseMaterializer: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.rebase,
    },
    {
        kind: "Memory",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.memoryCatalog,
        rebaseMaterializer: CLAUDECODE_EXACT_TARGET_COMPONENTS.MemoryCatalog.rebase,
    },
    {
        kind: "Memory",
        dialectId: CLAUDECODE_NATIVE_DIALECTS.memoryTopic,
        rebaseMaterializer: CLAUDECODE_EXACT_TARGET_COMPONENTS.Memory.rebase,
    },
];

export const CLAUDECODE_DIALECT_CONTRACTS: AdapterDialectContractSetV1 = {
    native: NATIVE_ROWS.map(({ kind, dialectId, rebaseMaterializer }) =>
        defineNativeDialectContractV1({
            kind,
            dialectId,
            ...(rebaseMaterializer === undefined ? {} : { rebaseMaterializer }),
            ...(kind === "Skill" ? { rebase: CLAUDECODE_SKILL_GRAPH_REBASE_MATERIALIZER } : {}),
            validateSameContent: validateClaudeCodeNativeDialect,
        }),
    ),
    restoration: [memoryTopicRestorationContract()],
    portableEntries: [
        entryContract("Workflow", "workflow_instruction", CLAUDECODE_NATIVE_DIALECTS.commandWorkflow),
        entryContract("Workflow", "workflow_executable", CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow),
        entryContract("Skill", "skill_entry", SKILL_ENTRY_DIALECT),
        entryContract("Subagent", "subagent_initial_prompt", INITIAL_PROMPT_DIALECT),
    ],
    portableSelectors: [
        ...["workflow_tool", "skill_tool", "subagent_tool"].map((field) =>
            selectorContract(field as PortableSelectorDialectFieldV1, TOOL_DIALECT),
        ),
        ...["workflow_model", "skill_model", "subagent_model"].map((field) =>
            selectorContract(field as PortableSelectorDialectFieldV1, CLAUDECODE_MODEL_DIALECT),
        ),
        ...["workflow_effort", "skill_effort", "subagent_effort"].map((field) =>
            selectorContract(field as PortableSelectorDialectFieldV1, CLAUDECODE_EFFORT_DIALECT),
        ),
        selectorContract("workflow_shell", CLAUDECODE_SHELL_DIALECT),
        selectorContract("skill_agent", SKILL_AGENT_DIALECT),
        selectorContract("subagent_permission", PERMISSION_DIALECT),
        selectorContract("subagent_turn_limit", CLAUDECODE_TURN_LIMIT_DIALECT),
        selectorContract("subagent_color", CLAUDECODE_COLOR_DIALECT),
    ],
};

function entryContract(
    kind: "Workflow" | "Skill" | "Subagent",
    field: PortableEntryDialectFieldV1,
    dialectId: string,
): AdapterPortableEntryDialectContractV1 {
    return definePortableEntryDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: CLAUDE_RUNTIME_IDS,
        validateCanonicalEntry: validatePortableEntry,
        validateSourceApplicability: supportsClaudeSource,
    });
}

function selectorContract(field: PortableSelectorDialectFieldV1, dialectId: string): AdapterPortableSelectorDialectContractV1 {
    const kind = field.startsWith("workflow_") ? "Workflow" : field.startsWith("skill_") ? "Skill" : "Subagent";
    return definePortableSelectorDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: CLAUDE_RUNTIME_IDS,
        validateSelector: validatePortableSelector,
        validateSourceApplicability: supportsClaudeSource,
    });
}

function supportsClaudeSource(source: PortableDialectSourceRuntimeV1): boolean {
    return CLAUDE_RUNTIME_IDS.includes(source.agentRuntimeId);
}

function validatePortableEntry(input: PortableEntryDialectValidationInputV1): boolean {
    const { use, versionStatus, canonical, canonicalFiles } = input;
    if (canonical.kind !== use.kind) return false;
    if (use.field === "workflow_instruction") {
        return (
            canonical.kind === "Workflow" &&
            canonical.typeData.implementation.kind === "instructions" &&
            canonical.typeData.implementation.instructionDialectId === use.dialectId &&
            (canonical.typeData.implementation.execution.agent.mode !== "agent_runtime_named" ||
                isClaudeRuntimeNativeAgent(canonical.typeData.implementation.execution.agent.selector)) &&
            (versionStatus === "incomplete" || entryExists(canonicalFiles, use.logicalPath))
        );
    }
    if (use.field === "workflow_executable") {
        return (
            canonical.kind === "Workflow" &&
            canonical.typeData.implementation.kind === "executable" &&
            canonical.typeData.implementation.executableDialectId === use.dialectId &&
            (versionStatus === "incomplete" || entryExists(canonicalFiles, use.logicalPath))
        );
    }
    if (use.field === "skill_entry") {
        return (
            canonical.kind === "Skill" &&
            canonical.typeData.entryDialectId === use.dialectId &&
            (versionStatus === "incomplete" || entryExists(canonicalFiles, use.logicalPath))
        );
    }
    if (
        canonical.kind !== "Subagent" ||
        canonical.typeData.directInvocation.mode !== "user_selectable" ||
        canonical.typeData.directInvocation.initialPrompt.mode !== "resource" ||
        canonical.typeData.directInvocation.initialPrompt.dialectId !== use.dialectId ||
        canonical.typeData.directInvocation.initialPrompt.logicalPath !== use.logicalPath
    ) {
        return false;
    }
    if (versionStatus === "incomplete") return true;
    const resource = canonicalFiles.find((file) => file.file.logicalPath === use.logicalPath);
    return (
        resource?.file.role === "resource" &&
        resource.contentKind === "text" &&
        resource.text.trim() !== "" &&
        !resource.file.executable
    );
}

function validatePortableSelector(use: PortableSelectorDialectUseV1): boolean {
    const value = use.value;
    if (use.field === "workflow_tool" || use.field === "skill_tool" || use.field === "subagent_tool") {
        return value.valueKind === "selector" && value.selector.trim() !== "";
    }
    if (use.field === "workflow_shell") {
        return value.valueKind === "selector" && (value.selector === "bash" || value.selector === "powershell");
    }
    if (use.field === "skill_agent") {
        return value.valueKind === "selector" && isClaudeRuntimeNativeAgent(value.selector);
    }
    if (use.field === "workflow_model" || use.field === "skill_model" || use.field === "subagent_model") {
        return (
            value.valueKind === "relative_tier" &&
            value.selector.trim() !== "" &&
            value.relativeTier === modelTier(value.selector)
        );
    }
    if (use.field === "workflow_effort" || use.field === "skill_effort" || use.field === "subagent_effort") {
        return (
            value.valueKind === "relative_tier" &&
            value.selector.trim() !== "" &&
            value.relativeTier === effortTier(value.selector)
        );
    }
    if (use.field === "subagent_permission" && value.valueKind === "permission_effect") {
        const diagnostics: Parameters<typeof permissionPolicy>[1] = [];
        const resolved = permissionPolicy(value.selector, diagnostics, "");
        return diagnostics.length === 0 && resolved.mode === "selected" && resolved.effect === value.effect;
    }
    if (use.field === "subagent_turn_limit" && value.valueKind === "positive_limit") {
        return Number.isSafeInteger(value.limit) && value.limit > 0;
    }
    return use.field === "subagent_color" && value.valueKind === "selector" && value.selector.trim() !== "";
}

function memoryTopicRestorationContract(): AdapterRestorationDialectContractV1 {
    return {
        definition: {
            kind: "Memory",
            dialectId: CLAUDECODE_NATIVE_DIALECTS.memoryTopic,
            payloadCodecValidator: component("claudecode-memory-topic-v1.restoration-payload"),
            transitionValidator: component("claudecode-memory-topic-v1.restoration-transition"),
        },
        validatePayload: validateMemoryTopicRestorationPayload,
    };
}

function validateMemoryTopicRestorationPayload(bytes: Uint8Array): boolean {
    return parseClaudeMemoryTopicRestorationPayload(bytes) !== null;
}
