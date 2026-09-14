/** Strict runtime validators for the six canonical AssetKind/typeData pairs. */

import type {
    AssetKindTypeDataV2,
    GuidanceTypeDataV1,
    MemoryTypeDataV2,
    RuleTypeDataV2,
    SkillTypeDataV2,
    SubagentInstructionEntryV1,
    SubagentTypeDataV2,
    WorkflowTypeDataV2,
} from "../contracts/specs";
import type { StrictSchema } from "../foundation/strict-schema";
import {
    schemaArrayWithOptions as array,
    schemaLiteral as literal,
    schemaObject as object,
    schemaStringEnum as oneOf,
    schemaUnion as union,
    validateStrict,
} from "../foundation/strict-schema";
import { isPosixRelativePath, isUuidV4 } from "../foundation/validators";

const text: StrictSchema = { kind: "string" };
const nonBlank: StrictSchema = { kind: "string", nonBlank: true };
const bool: StrictSchema = { kind: "boolean" };
const uuid: StrictSchema = { kind: "custom", check: isUuidV4 };
const posixPath: StrictSchema = { kind: "custom", check: isPosixRelativePath };
const positiveInteger: StrictSchema = { kind: "number", integer: true, min: 1 };
const finiteNumber: StrictSchema = { kind: "number" };

const uniqueString = (value: unknown): string => value as string;

const dialectSelector = object({ dialectId: nonBlank, selector: nonBlank });
const toolSelectorKey = (value: unknown): string => {
    const selector = value as { dialectId: string; selector: string };
    return `${selector.dialectId}\0${selector.selector}`;
};
const toolSelectorArray = array(dialectSelector, { uniqueBy: toolSelectorKey });
const toolPolicy = object({
    preapproved: toolSelectorArray,
    denied: toolSelectorArray,
    otherwise: literal("inherit_agent_runtime_policy"),
});

const relativeTier = union(literal(-1), { kind: "number", integer: true, min: 1, max: 10 });
const dialectTierSelection = union(
    object({ mode: literal("inherit") }),
    object({ mode: literal("selected"), dialectId: nonBlank, selector: nonBlank, relativeTier }),
);

const GUIDANCE_SCHEMA = object({ schemaVersion: literal(1) });
const RULE_SCHEMA = object({
    schemaVersion: literal(2),
    name: nonBlank,
    description: text,
    activation: union(
        object({ mode: literal("always") }),
        object({ mode: literal("manual") }),
        object({ mode: literal("model_decision") }),
        object({
            mode: literal("path"),
            globs: array(nonBlank, { minLength: 1, uniqueBy: uniqueString }),
        }),
    ),
});

const workflowAgent = union(
    object({ mode: literal("agent_runtime_default") }),
    object({ mode: literal("agent_runtime_named"), selector: nonBlank }),
    object({ mode: literal("bound"), targetAssetVersionId: uuid }),
);
const workflowShell = union(
    object({ mode: literal("none") }),
    object({ mode: literal("agent_runtime_default") }),
    object({ mode: literal("selected"), dialectId: nonBlank, selector: nonBlank }),
);
const workflowExecution = object({
    mode: oneOf("caller", "isolated"),
    agent: workflowAgent,
    model: dialectTierSelection,
    effort: dialectTierSelection,
    shell: workflowShell,
});
const workflowImplementation = union(
    object({
        kind: literal("instructions"),
        instructionDialectId: nonBlank,
        execution: workflowExecution,
        toolPolicy,
    }),
    object({
        kind: literal("executable"),
        executableDialectId: nonBlank,
    }),
);
const WORKFLOW_SCHEMA = object({
    schemaVersion: literal(2),
    name: nonBlank,
    description: text,
    implementation: workflowImplementation,
    invocation: object({
        commandNames: array(nonBlank, { uniqueBy: uniqueString }),
        userInvocable: bool,
        agentInvocable: bool,
        argumentHint: text,
        argumentNames: array(nonBlank, { uniqueBy: uniqueString }),
    }),
});

const portablePattern: StrictSchema = {
    kind: "custom",
    check: (value) => {
        if (
            typeof value !== "string" ||
            value.trim().length === 0 ||
            value.includes("\0") ||
            value.includes("\\") ||
            value.startsWith("/")
        ) {
            return false;
        }
        return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
    },
};
const skillInvocation = object({
    pathCondition: union(
        object({ mode: literal("none") }),
        object({
            mode: literal("required"),
            patterns: array(portablePattern, { minLength: 1, uniqueBy: uniqueString }),
        }),
    ),
    user: union(object({ mode: literal("not_directly_invocable") }), object({ mode: literal("direct"), commandName: nonBlank })),
    model: union(object({ mode: literal("disabled") }), object({ mode: literal("model_decision") })),
    argumentHint: text,
    argumentNames: array(nonBlank, { uniqueBy: uniqueString }),
});
const skillAgent = union(
    object({ mode: literal("agent_runtime_default") }),
    object({ mode: literal("agent_runtime_named"), dialectId: nonBlank, selector: nonBlank }),
    object({ mode: literal("bound"), targetAssetVersionId: uuid }),
);
const skillExecution = union(
    object({ mode: literal("caller"), model: dialectTierSelection, effort: dialectTierSelection }),
    object({
        mode: literal("isolated"),
        agent: skillAgent,
        model: dialectTierSelection,
        effort: dialectTierSelection,
    }),
);
const SKILL_SCHEMA = object({
    schemaVersion: literal(2),
    name: nonBlank,
    description: nonBlank,
    whenToUse: text,
    entryDialectId: nonBlank,
    portableMetadata: object({
        license: text,
        compatibility: text,
        metadata: { kind: "record", value: text },
    }),
    invocation: skillInvocation,
    toolPolicy,
    execution: skillExecution,
});

const subagentToolSelector = union(
    object({ mode: literal("agent_runtime_tool"), selector: dialectSelector }),
    object({ mode: literal("bound_subagent"), targetAssetVersionId: uuid }),
);
const subagentToolKey = (value: unknown): string => {
    const selector = value as {
        mode: "agent_runtime_tool" | "bound_subagent";
        selector?: { dialectId: string; selector: string };
        targetAssetVersionId?: string;
    };
    return selector.mode === "agent_runtime_tool"
        ? `tool:${toolSelectorKey(selector.selector)}`
        : `subagent:${selector.targetAssetVersionId}`;
};
const subagentTools = object({
    availability: object({
        base: union(
            object({ mode: literal("inherit_available") }),
            object({ mode: literal("none") }),
            object({
                mode: literal("allowlist"),
                allowed: array(subagentToolSelector, { uniqueBy: subagentToolKey }),
            }),
        ),
        unavailable: array(subagentToolSelector, { uniqueBy: subagentToolKey }),
    }),
    permission: object({
        rules: array(
            object({
                selector: subagentToolSelector,
                action: oneOf("preapproved", "ask", "deny"),
            }),
            {
                uniqueBy: (value) => subagentToolKey((value as { selector: unknown }).selector),
            },
        ),
        otherwise: literal("inherit_agent_runtime_policy"),
    }),
});
const subagentExecution = object({
    permission: union(
        object({ mode: literal("inherit") }),
        object({
            mode: literal("selected"),
            dialectId: nonBlank,
            selector: nonBlank,
            effect: oneOf(
                "interactive",
                "read_only",
                "auto_approve_selected_operations",
                "auto_deny_unapproved",
                "bypass_permission_checks",
                "classifier_mediated",
            ),
        }),
    ),
    workspaceIsolation: union(object({ mode: literal("agent_runtime_default") }), object({ mode: literal("isolated_worktree") })),
    scheduling: union(
        object({ mode: literal("agent_runtime_default") }),
        object({ mode: literal("always_foreground") }),
        object({ mode: literal("always_background") }),
    ),
    turnLimit: union(
        object({ mode: literal("agent_runtime_default") }),
        object({ mode: literal("bounded"), dialectId: nonBlank, limit: positiveInteger }),
    ),
    model: dialectTierSelection,
    effort: dialectTierSelection,
    sampling: object({
        temperature: union(
            object({ mode: literal("agent_runtime_default") }),
            object({ mode: literal("selected"), value: finiteNumber }),
        ),
        topP: union(
            object({ mode: literal("agent_runtime_default") }),
            object({ mode: literal("selected"), value: finiteNumber }),
        ),
    }),
});
const SUBAGENT_SCHEMA = object({
    schemaVersion: literal(2),
    name: nonBlank,
    description: nonBlank,
    promptContextPolicy: union(
        object({ mode: literal("agent_runtime_default") }),
        object({
            mode: literal("selected"),
            dialectId: nonBlank,
            selectors: array(nonBlank, { minLength: 1, uniqueBy: uniqueString }),
        }),
    ),
    tools: subagentTools,
    dependencies: object({
        preloadedSkillVersionIds: array(uuid, { uniqueBy: uniqueString }),
    }),
    memory: union(
        object({ mode: literal("disabled") }),
        object({
            mode: literal("persistent"),
            storageScope: oneOf("global", "project_shared", "project_local"),
        }),
    ),
    execution: subagentExecution,
    directInvocation: union(
        object({ mode: literal("agent_runtime_default") }),
        object({ mode: literal("delegated_only") }),
        object({
            mode: literal("user_selectable"),
            initialPrompt: union(
                object({ mode: literal("none") }),
                object({ mode: literal("resource"), logicalPath: posixPath, dialectId: nonBlank }),
            ),
        }),
    ),
    presentation: object({
        listing: oneOf("agent_runtime_default", "visible", "hidden"),
        color: union(
            object({ mode: literal("agent_runtime_default") }),
            object({ mode: literal("selected"), dialectId: nonBlank, selector: nonBlank }),
        ),
    }),
});

const MEMORY_UNIT_SCHEMA = object({
    schemaVersion: literal(2),
    entityRole: literal("unit"),
    card: object({ name: nonBlank, description: text }),
    loading: object({ card: literal("high"), body: literal("low") }),
    applicabilityRule: text,
});
const MEMORY_CATALOG_SCHEMA = object({
    schemaVersion: literal(2),
    entityRole: literal("catalog"),
    members: array(object({ targetAssetVersionId: uuid, routingTitle: nonBlank, routingHint: text }), {
        uniqueBy: (value) => (value as { targetAssetVersionId: string }).targetAssetVersionId,
    }),
});
const MEMORY_SCHEMA = union(MEMORY_UNIT_SCHEMA, MEMORY_CATALOG_SCHEMA);

function toolPoliciesDoNotOverlap(value: unknown): boolean {
    const policy = value as {
        preapproved: Array<{ dialectId: string; selector: string }>;
        denied: Array<{ dialectId: string; selector: string }>;
    };
    const preapproved = new Set(policy.preapproved.map(toolSelectorKey));
    return policy.denied.every((selector) => !preapproved.has(toolSelectorKey(selector)));
}

export function isGuidanceTypeDataV1(value: unknown): value is GuidanceTypeDataV1 {
    return validateStrict(GUIDANCE_SCHEMA, value);
}

export function isRuleTypeDataV2(value: unknown): value is RuleTypeDataV2 {
    if (!validateStrict(RULE_SCHEMA, value)) return false;
    const rule = value as RuleTypeDataV2;
    return rule.activation.mode !== "model_decision" || rule.description.trim().length > 0;
}

export function isWorkflowTypeDataV2(value: unknown): value is WorkflowTypeDataV2 {
    if (!validateStrict(WORKFLOW_SCHEMA, value)) return false;
    const workflow = value as WorkflowTypeDataV2;
    return workflow.implementation.kind !== "instructions" || toolPoliciesDoNotOverlap(workflow.implementation.toolPolicy);
}

export function isSkillTypeDataV2(value: unknown): value is SkillTypeDataV2 {
    return validateStrict(SKILL_SCHEMA, value) && toolPoliciesDoNotOverlap((value as SkillTypeDataV2).toolPolicy);
}

export function isSubagentTypeDataV2(value: unknown): value is SubagentTypeDataV2 {
    return validateStrict(SUBAGENT_SCHEMA, value);
}

export function isMemoryTypeDataV2(value: unknown): value is MemoryTypeDataV2 {
    return validateStrict(MEMORY_SCHEMA, value);
}

export function isAssetKindTypeDataV2(value: unknown): value is AssetKindTypeDataV2 {
    if (
        !validateStrict(
            object({
                kind: oneOf("Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"),
                typeData: { kind: "custom", check: () => true },
            }),
            value,
        )
    ) {
        return false;
    }
    const pair = value as { kind: AssetKindTypeDataV2["kind"]; typeData: unknown };
    switch (pair.kind) {
        case "Guidance":
            return isGuidanceTypeDataV1(pair.typeData);
        case "Rule":
            return isRuleTypeDataV2(pair.typeData);
        case "Workflow":
            return isWorkflowTypeDataV2(pair.typeData);
        case "Skill":
            return isSkillTypeDataV2(pair.typeData);
        case "Subagent":
            return isSubagentTypeDataV2(pair.typeData);
        case "Memory":
            return isMemoryTypeDataV2(pair.typeData);
    }
}

const SUBAGENT_ENTRY_SCHEMA = object({
    schemaVersion: literal(1),
    sections: array(object({ title: text, content: nonBlank }), { minLength: 1 }),
});

export function parseSubagentInstructionEntryV1(value: string): SubagentInstructionEntryV1 | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    return validateStrict(SUBAGENT_ENTRY_SCHEMA, parsed) ? (parsed as SubagentInstructionEntryV1) : null;
}
