/** Immutable OpenCode native dialect registrations. */

import type {
    AdapterDialectContractSetV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AssetKind,
    PortableEntryDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
} from "@oaam/core";
import {
    defineDialectComponentV1 as component,
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1 as entryExists,
} from "@oaam/adapter-framework";
import { OPENCODE_NATIVE_DIALECTS, validateOpencodeNativeDialect } from "./opencode-source-read";
import { isOpencodeColor } from "./opencode-source-read-fields";
import {
    COLOR_DIALECT,
    MODEL_DIALECT,
    TOOL_DIALECT,
    TURN_LIMIT_DIALECT,
    VARIANT_DIALECT,
    NATIVE_AGENT_NAMES,
} from "./opencode-source-read-model";
import {
    OPENCODE_SKILL_REBASE_MATERIALIZER,
    OPENCODE_SKILL_TARGET_COMPONENTS,
    OPENCODE_CLI_SKILL_REBASE_MATERIALIZER,
    OPENCODE_CLI_SKILL_TARGET_COMPONENTS,
} from "./opencode-target-skill";
import { OPENCODE_SUBAGENT_TARGET_COMPONENTS } from "./opencode-target-subagent";
import { OPENCODE_WORKFLOW_TARGET_COMPONENTS } from "./opencode-target-workflow";

const OPENCODE_HISTORICAL_RULE_REBASE_COMPONENT = component("opencode.instructions-config-parent-native-rebase-v1");

const OPENCODE_RUNTIME_IDS = ["OPENCODE_APP", "OPENCODE_CLI"];
const SKILL_ENTRY_DIALECT = "opencode-skill-markdown-v1";

const NATIVE_ROWS: ReadonlyArray<readonly [AssetKind, string]> = [
    ["Guidance", OPENCODE_NATIVE_DIALECTS.guidance],
    ["Rule", OPENCODE_NATIVE_DIALECTS.instructionsRule],
    ["Workflow", OPENCODE_NATIVE_DIALECTS.commandWorkflow],
    ["Skill", OPENCODE_NATIVE_DIALECTS.skill],
    ["Skill", OPENCODE_NATIVE_DIALECTS.skillCli],
    ["Subagent", OPENCODE_NATIVE_DIALECTS.subagent],
];

/**
 * Dialect IDs are append-only semantic identities. Runtime path/evidence-only
 * changes keep the current ID. File-graph, schema, normalization, canonical
 * mapping, or validator changes require a new -vN row while the old validator
 * remains registered for historical Version reopen.
 */
export const OPENCODE_DIALECT_CONTRACTS: AdapterDialectContractSetV1 = {
    native: NATIVE_ROWS.map(([kind, dialectId]) =>
        defineNativeDialectContractV1({
            kind,
            dialectId,
            ...(dialectId === OPENCODE_NATIVE_DIALECTS.instructionsRule
                ? { rebaseMaterializer: OPENCODE_HISTORICAL_RULE_REBASE_COMPONENT }
                : dialectId === OPENCODE_NATIVE_DIALECTS.commandWorkflow
                  ? { rebaseMaterializer: OPENCODE_WORKFLOW_TARGET_COMPONENTS.rebase }
                  : dialectId === OPENCODE_NATIVE_DIALECTS.skillCli
                    ? { rebaseMaterializer: OPENCODE_CLI_SKILL_TARGET_COMPONENTS.rebase }
                    : dialectId === OPENCODE_NATIVE_DIALECTS.skill
                      ? { rebaseMaterializer: OPENCODE_SKILL_TARGET_COMPONENTS.rebase }
                      : dialectId === OPENCODE_NATIVE_DIALECTS.subagent
                        ? { rebaseMaterializer: OPENCODE_SUBAGENT_TARGET_COMPONENTS.rebase }
                        : {}),
            ...(kind === "Skill"
                ? {
                      rebase:
                          dialectId === OPENCODE_NATIVE_DIALECTS.skillCli
                              ? OPENCODE_CLI_SKILL_REBASE_MATERIALIZER
                              : OPENCODE_SKILL_REBASE_MATERIALIZER,
                  }
                : {}),
            validateSameContent: validateOpencodeNativeDialect,
        }),
    ),
    restoration: [],
    portableEntries: [
        portableEntry("Workflow", "workflow_instruction", OPENCODE_NATIVE_DIALECTS.commandWorkflow),
        portableEntry("Skill", "skill_entry", SKILL_ENTRY_DIALECT),
        portableEntry("Skill", "skill_entry", "opencode-skill-markdown-v2", ["OPENCODE_CLI"]),
    ],
    portableSelectors: [
        portableSelector("workflow_model", MODEL_DIALECT),
        portableSelector("workflow_effort", VARIANT_DIALECT),
        portableSelector("subagent_tool", TOOL_DIALECT),
        portableSelector("subagent_model", MODEL_DIALECT),
        portableSelector("subagent_effort", VARIANT_DIALECT),
        portableSelector("subagent_turn_limit", TURN_LIMIT_DIALECT),
        portableSelector("subagent_color", COLOR_DIALECT),
    ],
};

function portableEntry(
    kind: "Workflow" | "Skill",
    field: "workflow_instruction" | "skill_entry",
    dialectId: string,
    runtimeIds: string[] = OPENCODE_RUNTIME_IDS,
): AdapterPortableEntryDialectContractV1 {
    return definePortableEntryDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: runtimeIds,
        validateCanonicalEntry: validatePortableEntry,
        validateSourceApplicability: (source) => runtimeIds.includes(source.agentRuntimeId),
    });
}

function portableSelector(field: PortableSelectorDialectFieldV1, dialectId: string): AdapterPortableSelectorDialectContractV1 {
    const kind = field.startsWith("workflow_") ? "Workflow" : "Subagent";
    return definePortableSelectorDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: OPENCODE_RUNTIME_IDS,
        validateSelector: validatePortableSelector,
        validateSourceApplicability: supportsOpencodeSource,
    });
}

function supportsOpencodeSource(source: PortableDialectSourceRuntimeV1): boolean {
    return OPENCODE_RUNTIME_IDS.includes(source.agentRuntimeId);
}

function validatePortableEntry(input: PortableEntryDialectValidationInputV1): boolean {
    const { use, versionStatus, canonical, canonicalFiles } = input;
    if (use.kind !== canonical.kind) return false;
    if (canonical.kind === "Workflow" && use.field === "workflow_instruction") {
        return (
            canonical.typeData.implementation.kind === "instructions" &&
            canonical.typeData.implementation.instructionDialectId === use.dialectId &&
            (canonical.typeData.implementation.execution.agent.mode !== "agent_runtime_named" ||
                NATIVE_AGENT_NAMES.has(canonical.typeData.implementation.execution.agent.selector)) &&
            (versionStatus === "incomplete" || entryExists(canonicalFiles, use.logicalPath))
        );
    }
    if (canonical.kind === "Skill" && use.field === "skill_entry") {
        return (
            canonical.typeData.entryDialectId === use.dialectId &&
            (versionStatus === "incomplete" || entryExists(canonicalFiles, use.logicalPath))
        );
    }
    return false;
}

function validatePortableSelector(use: PortableSelectorDialectUseV1): boolean {
    const value = use.value;
    if (use.kind !== "Workflow" && use.kind !== "Subagent") return false;
    if (use.field === "subagent_tool") {
        return value.valueKind === "selector" && value.selector.trim() !== "";
    }
    if (
        use.field === "workflow_model" ||
        use.field === "workflow_effort" ||
        use.field === "subagent_model" ||
        use.field === "subagent_effort"
    ) {
        if (value.valueKind !== "relative_tier") return false;
        return value.selector.trim() !== "" && value.relativeTier === -1;
    }
    if (use.field === "subagent_turn_limit" && value.valueKind === "positive_limit") {
        return Number.isSafeInteger(value.limit) && value.limit > 0;
    }
    return use.field === "subagent_color" && value.valueKind === "selector" && isOpencodeColor(value.selector);
}
