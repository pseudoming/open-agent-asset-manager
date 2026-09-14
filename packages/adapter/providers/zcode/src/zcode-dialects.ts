/** Immutable ZCode native dialect registrations. */

import type {
    AdapterDialectContractSetV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AdapterRestorationDialectContractV1,
    AssetKind,
    PortableEntryDialectFieldV1,
    PortableDialectSourceRuntimeV1,
    PortableEntryDialectValidationInputV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
} from "@oaam/core";
import {
    defineDialectComponentV1 as component,
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1,
} from "@oaam/adapter-framework";
import { ZCODE_NATIVE_DIALECTS } from "./zcode-source-read-model";
import { parseZcodeMemoryTopicRestorationPayload } from "./zcode-source-read-memory";
import { validateZcodeNativeDialect } from "./zcode-source-read-native";
import {
    isZcodeColor,
    isZcodeSubagentToolName,
    permissionPolicy,
    ZCODE_COLOR_DIALECT,
    ZCODE_MODEL_DIALECT,
    ZCODE_PERMISSION_DIALECT,
    ZCODE_COMMAND_TOOL_DIALECT,
    ZCODE_SUBAGENT_TOOL_DIALECT,
    ZCODE_TURN_LIMIT_DIALECT,
} from "./zcode-source-read-fields";
import { ZCODE_WORKFLOW_TARGET_COMPONENTS } from "./zcode-target-workflow";
import { ZCODE_SKILL_REBASE_MATERIALIZER, ZCODE_SKILL_TARGET_COMPONENTS } from "./zcode-target-skill";
import { ZCODE_SUBAGENT_TARGET_COMPONENTS } from "./zcode-target-subagent";
import { ZCODE_MEMORY_TARGET_COMPONENTS } from "./zcode-target-memory";

const ZCODE_RUNTIME_IDS = ["ZCODE_APP"];
const NATIVE_ROWS: ReadonlyArray<readonly [AssetKind, string]> = [
    ["Guidance", ZCODE_NATIVE_DIALECTS.guidance],
    ["Workflow", ZCODE_NATIVE_DIALECTS.commandWorkflow],
    ["Workflow", ZCODE_NATIVE_DIALECTS.scriptWorkflow],
    ["Skill", ZCODE_NATIVE_DIALECTS.skill],
    ["Subagent", ZCODE_NATIVE_DIALECTS.subagent],
    ["Memory", ZCODE_NATIVE_DIALECTS.memoryCatalog],
    ["Memory", ZCODE_NATIVE_DIALECTS.memoryTopic],
];

export const ZCODE_DIALECT_CONTRACTS: AdapterDialectContractSetV1 = {
    native: NATIVE_ROWS.map(([kind, dialectId]) =>
        defineNativeDialectContractV1({
            kind,
            dialectId,
            ...(dialectId === ZCODE_NATIVE_DIALECTS.commandWorkflow
                ? { rebaseMaterializer: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandRebase }
                : dialectId === ZCODE_NATIVE_DIALECTS.skill
                  ? { rebaseMaterializer: ZCODE_SKILL_TARGET_COMPONENTS.rebase }
                  : dialectId === ZCODE_NATIVE_DIALECTS.subagent
                    ? { rebaseMaterializer: ZCODE_SUBAGENT_TARGET_COMPONENTS.rebase }
                    : dialectId === ZCODE_NATIVE_DIALECTS.memoryCatalog
                      ? { rebaseMaterializer: ZCODE_MEMORY_TARGET_COMPONENTS.catalogRebase }
                      : dialectId === ZCODE_NATIVE_DIALECTS.memoryTopic
                        ? { rebaseMaterializer: ZCODE_MEMORY_TARGET_COMPONENTS.unitRebase }
                        : {}),
            ...(kind === "Skill" ? { rebase: ZCODE_SKILL_REBASE_MATERIALIZER } : {}),
            validateSameContent: validateZcodeNativeDialect,
        }),
    ),
    restoration: [memoryTopicRestorationContract()],
    portableEntries: [
        portableEntry("Workflow", "workflow_instruction", ZCODE_NATIVE_DIALECTS.commandWorkflow),
        portableEntry("Workflow", "workflow_executable", ZCODE_NATIVE_DIALECTS.scriptWorkflow),
        portableEntry("Skill", "skill_entry", "zcode-skill-markdown-v1"),
    ],
    portableSelectors: [
        portableSelector("Workflow", "workflow_tool", ZCODE_COMMAND_TOOL_DIALECT),
        portableSelector("Workflow", "workflow_model", ZCODE_MODEL_DIALECT),
        portableSelector("Subagent", "subagent_tool", ZCODE_SUBAGENT_TOOL_DIALECT),
        portableSelector("Subagent", "subagent_permission", ZCODE_PERMISSION_DIALECT),
        portableSelector("Subagent", "subagent_model", ZCODE_MODEL_DIALECT),
        portableSelector("Subagent", "subagent_turn_limit", ZCODE_TURN_LIMIT_DIALECT),
        portableSelector("Subagent", "subagent_color", ZCODE_COLOR_DIALECT),
    ],
};

function memoryTopicRestorationContract(): AdapterRestorationDialectContractV1 {
    return {
        definition: {
            kind: "Memory",
            dialectId: ZCODE_NATIVE_DIALECTS.memoryTopic,
            payloadCodecValidator: component("zcode-memory-topic-v1.restoration-payload"),
            transitionValidator: component("zcode-memory-topic-v1.restoration-transition"),
        },
        validatePayload: validateMemoryTopicRestorationPayload,
    };
}

function validateMemoryTopicRestorationPayload(bytes: Uint8Array): boolean {
    return parseZcodeMemoryTopicRestorationPayload(bytes) !== null;
}

function portableEntry(
    kind: "Workflow" | "Skill",
    field: PortableEntryDialectFieldV1,
    dialectId: string,
): AdapterPortableEntryDialectContractV1 {
    return definePortableEntryDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: ZCODE_RUNTIME_IDS,
        validateCanonicalEntry: validatePortableEntry,
        validateSourceApplicability: supportsZcodeSource,
    });
}

function portableSelector(
    kind: "Workflow" | "Subagent",
    field: PortableSelectorDialectFieldV1,
    dialectId: string,
): AdapterPortableSelectorDialectContractV1 {
    return definePortableSelectorDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: ZCODE_RUNTIME_IDS,
        validateSelector: validatePortableSelector,
        validateSourceApplicability: supportsZcodeSource,
    });
}

function validatePortableEntry(input: PortableEntryDialectValidationInputV1): boolean {
    const { use, canonical, versionStatus, canonicalFiles } = input;
    if (canonical.kind !== use.kind) return false;
    if (canonical.kind === "Skill" && use.field === "skill_entry") {
        return (
            canonical.typeData.entryDialectId === use.dialectId &&
            (versionStatus === "incomplete" || hasCanonicalTextEntryV1(canonicalFiles, use.logicalPath))
        );
    }
    if (canonical.kind !== "Workflow") return false;
    if (use.field === "workflow_instruction") {
        return (
            canonical.typeData.implementation.kind === "instructions" &&
            canonical.typeData.implementation.instructionDialectId === use.dialectId &&
            canonical.typeData.implementation.execution.agent.mode === "agent_runtime_default" &&
            (versionStatus === "incomplete" || hasCanonicalTextEntryV1(canonicalFiles, use.logicalPath))
        );
    }
    return (
        use.field === "workflow_executable" &&
        canonical.typeData.implementation.kind === "executable" &&
        canonical.typeData.implementation.executableDialectId === use.dialectId &&
        (versionStatus === "incomplete" || hasCanonicalTextEntryV1(canonicalFiles, use.logicalPath))
    );
}

function validatePortableSelector(use: PortableSelectorDialectUseV1): boolean {
    if (use.kind !== "Workflow" && use.kind !== "Subagent") return false;
    const value = use.value;
    if (use.field === "workflow_tool") {
        return value.valueKind === "selector" && value.selector.trim() !== "";
    }
    if (use.field === "subagent_tool") {
        return value.valueKind === "selector" && isZcodeSubagentToolName(value.selector);
    }
    if (use.field === "workflow_model" || use.field === "subagent_model") {
        return value.valueKind === "relative_tier" && value.selector.trim() !== "" && value.relativeTier === -1;
    }
    if (use.field === "subagent_permission" && value.valueKind === "permission_effect") {
        const diagnostics: Parameters<typeof permissionPolicy>[1] = [];
        const resolved = permissionPolicy(value.selector, diagnostics, "");
        return diagnostics.length === 0 && resolved.mode === "selected" && resolved.effect === value.effect;
    }
    if (use.field === "subagent_turn_limit" && value.valueKind === "positive_limit") {
        return Number.isSafeInteger(value.limit) && value.limit > 0;
    }
    return use.field === "subagent_color" && value.valueKind === "selector" && isZcodeColor(value.selector);
}

function supportsZcodeSource(source: PortableDialectSourceRuntimeV1): boolean {
    return ZCODE_RUNTIME_IDS.includes(source.agentRuntimeId);
}
