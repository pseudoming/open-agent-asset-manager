/** Immutable Antigravity native dialect registrations. */

import {
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1 as entryExists,
} from "@oaam/adapter-framework";
import type {
    AdapterDialectContractSetV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AssetKind,
    PortableDialectSourceRuntimeV1,
    PortableEntryDialectValidationInputV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    VersionedContractComponentRef,
} from "@oaam/core";
import { ANTIGRAVITY_NATIVE_DIALECTS, validateAntigravityNativeDialect } from "./antigravity-source-read";
import { ANTIGRAVITY_SUBAGENT_MODEL_DIALECT, ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT } from "./antigravity-subagent-markdown";
import { ANTIGRAVITY_RULE_TARGET_COMPONENTS } from "./antigravity-target-exact-rule";
import { ANTIGRAVITY_SKILL_REBASE_MATERIALIZER, ANTIGRAVITY_SKILL_TARGET_COMPONENTS } from "./antigravity-target-skill";
import { ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS } from "./antigravity-target-subagent";
import { ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS, ANTIGRAVITY_WORKFLOW_REBASE_MATERIALIZER } from "./antigravity-target-workflow";

const ANTIGRAVITY_ENTRY_RUNTIME_IDS = ["ANTIGRAVITY_APP", "ANTIGRAVITY_CLI", "ANTIGRAVITY_IDE"];
const ANTIGRAVITY_SELECTOR_RUNTIME_IDS = ["ANTIGRAVITY_APP", "ANTIGRAVITY_CLI"];
const SKILL_ENTRY_DIALECT = "antigravity-skill-markdown-v1";
const CONTEXT_DIALECT = "antigravity-context-sections-v1";
const TOOL_DIALECT = "antigravity-tool-name-v1";

const NATIVE_ROWS: ReadonlyArray<{
    kind: AssetKind;
    dialectId: string;
    rebaseMaterializer?: VersionedContractComponentRef;
}> = [
    { kind: "Guidance", dialectId: ANTIGRAVITY_NATIVE_DIALECTS.guidance },
    {
        kind: "Rule",
        dialectId: ANTIGRAVITY_NATIVE_DIALECTS.rule,
        rebaseMaterializer: ANTIGRAVITY_RULE_TARGET_COMPONENTS.rebase,
    },
    {
        kind: "Workflow",
        dialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
        rebaseMaterializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.rebase,
    },
    {
        kind: "Skill",
        dialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
        rebaseMaterializer: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase,
    },
    {
        kind: "Skill",
        dialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFlat,
        rebaseMaterializer: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase,
    },
    { kind: "Subagent", dialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagent },
    {
        kind: "Subagent",
        dialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
        rebaseMaterializer: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.rebase,
    },
];

/**
 * Dialect ids are append-only semantic identities. If Antigravity changes a
 * file format, add a -vN row and keep the previous validator registered; never
 * mutate an existing row to reinterpret persisted native bytes.
 */
export const ANTIGRAVITY_DIALECT_CONTRACTS: AdapterDialectContractSetV1 = {
    native: NATIVE_ROWS.map(({ kind, dialectId, rebaseMaterializer }) =>
        defineNativeDialectContractV1({
            kind,
            dialectId,
            ...(rebaseMaterializer === undefined ? {} : { rebaseMaterializer }),
            ...(kind === "Skill" ? { rebase: ANTIGRAVITY_SKILL_REBASE_MATERIALIZER } : {}),
            ...(kind === "Workflow" ? { rebase: ANTIGRAVITY_WORKFLOW_REBASE_MATERIALIZER } : {}),
            validateSameContent: validateAntigravityNativeDialect,
        }),
    ),
    restoration: [],
    portableEntries: [
        portableEntry("Workflow", "workflow_instruction", ANTIGRAVITY_NATIVE_DIALECTS.workflow),
        portableEntry("Skill", "skill_entry", SKILL_ENTRY_DIALECT),
    ],
    portableSelectors: [
        portableSelector("subagent_context", CONTEXT_DIALECT),
        portableSelector("subagent_tool", TOOL_DIALECT),
        portableSelector("subagent_model", ANTIGRAVITY_SUBAGENT_MODEL_DIALECT),
        portableSelector("subagent_permission", ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT),
    ],
};

function portableEntry(
    kind: "Workflow" | "Skill",
    field: "workflow_instruction" | "skill_entry",
    dialectId: string,
): AdapterPortableEntryDialectContractV1 {
    return definePortableEntryDialectContractV1({
        kind,
        field,
        dialectId,
        applicableAgentRuntimeIds: ANTIGRAVITY_ENTRY_RUNTIME_IDS,
        validateCanonicalEntry: validatePortableEntry,
        validateSourceApplicability: (source) => supportsAntigravitySource(source, ANTIGRAVITY_ENTRY_RUNTIME_IDS),
    });
}

function portableSelector(field: PortableSelectorDialectFieldV1, dialectId: string): AdapterPortableSelectorDialectContractV1 {
    return definePortableSelectorDialectContractV1({
        kind: "Subagent",
        field,
        dialectId,
        applicableAgentRuntimeIds: ANTIGRAVITY_SELECTOR_RUNTIME_IDS,
        validateSelector: validatePortableSelector,
        validateSourceApplicability: (source) => supportsAntigravitySource(source, ANTIGRAVITY_SELECTOR_RUNTIME_IDS),
    });
}

function supportsAntigravitySource(source: PortableDialectSourceRuntimeV1, runtimeIds: readonly string[]): boolean {
    return runtimeIds.includes(source.agentRuntimeId);
}

function validatePortableEntry(input: PortableEntryDialectValidationInputV1): boolean {
    const { use, versionStatus, canonical, canonicalFiles } = input;
    if (use.kind !== canonical.kind) return false;
    if (canonical.kind === "Workflow" && use.field === "workflow_instruction") {
        return (
            canonical.typeData.implementation.kind === "instructions" &&
            canonical.typeData.implementation.instructionDialectId === use.dialectId &&
            canonical.typeData.implementation.execution.agent.mode !== "agent_runtime_named" &&
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
    if (use.kind !== "Subagent") return false;
    if (use.field === "subagent_context" && use.value.valueKind === "selector_set") {
        return (
            use.value.selectors.length > 0 &&
            new Set(use.value.selectors).size === use.value.selectors.length &&
            use.value.selectors.every((selector) => selector.trim() !== "")
        );
    }
    if (use.field === "subagent_tool") {
        return use.value.valueKind === "selector" && use.value.selector.trim() !== "";
    }
    if (use.field === "subagent_model" && use.value.valueKind === "relative_tier") {
        const tiers = { flash: 1, pro: 10 } as const;
        return tiers[use.value.selector as keyof typeof tiers] === use.value.relativeTier;
    }
    if (use.field === "subagent_permission" && use.value.valueKind === "permission_effect") {
        const effects = {
            off: "interactive",
            auto: "classifier_mediated",
            eager: "auto_approve_selected_operations",
            sandbox: "auto_approve_selected_operations",
        } as const;
        return effects[use.value.selector as keyof typeof effects] === use.value.effect;
    }
    return false;
}
