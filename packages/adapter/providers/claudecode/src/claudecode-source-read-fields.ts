/** Claude Code frontmatter coercion and execution-selector semantics. */

import type { OperationDiagnostic, SubagentTypeDataV2, ToolSelectorV1 } from "@oaam/core";
import {
    frontmatterString,
    frontmatterStringMap,
    frontmatterStrings,
    splitDelimited,
    type ParsedClaudeFrontmatter,
} from "./claudecode-frontmatter";
import { nonBlank, readDiagnostic, uniquePreservingOrder } from "./claudecode-source-read-foundation";
import type { RelativeTier } from "./claudecode-source-read-model";

const TOOL_DIALECT = "claudecode-tool-selector-v1";
const MODEL_DIALECT = "claudecode-model-selector-v1";
const EFFORT_DIALECT = "claudecode-effort-selector-v1";
const PERMISSION_DIALECT = "claudecode-permission-mode-v1";
const CLAUDE_RUNTIME_NATIVE_AGENTS = new Set([
    "Explore",
    "Plan",
    "claude-code-guide",
    "general-purpose",
    "statusline-setup",
    "verification",
]);

export const CLAUDECODE_MODEL_DIALECT = MODEL_DIALECT;
export const CLAUDECODE_EFFORT_DIALECT = EFFORT_DIALECT;
export const CLAUDECODE_SHELL_DIALECT = "claudecode-shell-selector-v1";
export const CLAUDECODE_TURN_LIMIT_DIALECT = "claudecode-max-turns-v1";
export const CLAUDECODE_COLOR_DIALECT = "claudecode-color-v1";

export function selectorTier(
    raw: string | undefined,
    dialectId: string,
    rank: (selector: string) => RelativeTier,
):
    | { mode: "inherit" }
    | {
          mode: "selected";
          dialectId: string;
          selector: string;
          relativeTier: RelativeTier;
      } {
    const selector = nonBlank(raw);
    return selector === undefined || selector === "inherit"
        ? { mode: "inherit" }
        : { mode: "selected", dialectId, selector, relativeTier: rank(selector) };
}

export function modelTier(selector: string): RelativeTier {
    const normalized = selector.toLowerCase();
    if (normalized.includes("haiku")) return 1;
    if (normalized.includes("sonnet")) return 5;
    if (normalized.includes("opus")) return 10;
    return -1;
}

export function effortTier(selector: string): RelativeTier {
    switch (selector.toLowerCase()) {
        case "low":
            return 1;
        case "medium":
            return 4;
        case "high":
            return 7;
        case "max":
        case "xhigh":
            return 10;
        default:
            return -1;
    }
}

export function permissionPolicy(
    selector: string | undefined,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["execution"]["permission"] {
    if (selector === undefined) return { mode: "inherit" };
    const effects: Record<string, Exclude<SubagentTypeDataV2["execution"]["permission"], { mode: "inherit" }>["effect"]> = {
        default: "interactive",
        manual: "interactive",
        plan: "read_only",
        acceptEdits: "auto_approve_selected_operations",
        dontAsk: "auto_deny_unapproved",
        bypassPermissions: "bypass_permission_checks",
        auto: "classifier_mediated",
    };
    const effect = effects[selector];
    if (effect === undefined) {
        diagnostics.push(
            readDiagnostic(
                "claudecode.subagent_permission_invalid",
                "Unknown Claude Subagent permission mode",
                "invalid_schema",
                "error",
                path,
            ),
        );
        return { mode: "inherit" };
    }
    return { mode: "selected", dialectId: PERMISSION_DIALECT, selector, effect };
}

export function memoryPolicy(
    selector: string | undefined,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["memory"] {
    if (selector === undefined) return { mode: "disabled" };
    const scopes = {
        user: "global",
        project: "project_shared",
        local: "project_local",
    } as const;
    const storageScope = scopes[selector as keyof typeof scopes];
    if (storageScope === undefined) {
        diagnostics.push(
            readDiagnostic(
                "claudecode.subagent_memory_invalid",
                "Unknown Claude Subagent memory scope",
                "invalid_schema",
                "error",
                path,
            ),
        );
        return { mode: "disabled" };
    }
    return { mode: "persistent", storageScope };
}

export function toolSelectors(values: string[]): ToolSelectorV1[] {
    return uniquePreservingOrder(values)
        .filter((selector) => selector.trim() !== "")
        .map((selector) => ({ dialectId: TOOL_DIALECT, selector }));
}

export function toolSelectorKey(selector: ToolSelectorV1): string {
    return `${selector.dialectId}\0${selector.selector}`;
}

export function isNestedAgentSelector(selector: string): boolean {
    return selector.startsWith("Agent(") || selector.startsWith("Task(");
}

export function claudeBooleanFrontmatter(
    parsed: ParsedClaudeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Skill" | "Subagent",
): boolean | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = parsed.values[key];
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    diagnostics.push(
        readDiagnostic(
            "claudecode.boolean_frontmatter_invalid",
            `${kind} field ${key} must be a boolean or the exact string true/false`,
            "invalid_schema",
            "error",
            path,
        ),
    );
    return undefined;
}

export function claudeOptionalString(
    parsed: ParsedClaudeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Skill" | "Subagent",
): string | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = parsed.values[key];
    if (typeof value === "string") return value;
    diagnostics.push(
        readDiagnostic(
            `claudecode.${kind.toLowerCase()}_${key.toLowerCase()}_type_fallback`,
            `${kind} field ${key} is not a string; OAAM retained the native source and omitted the canonical selector`,
            "invalid_schema",
            "warning",
            path,
        ),
    );
    return undefined;
}

export function claudeStringList(
    parsed: ParsedClaudeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Skill" | "Subagent",
): string[] | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const values = frontmatterStrings(parsed, key);
    if (values !== undefined) return values;
    diagnostics.push(
        readDiagnostic(
            `claudecode.${kind.toLowerCase()}_${key.toLowerCase()}_invalid`,
            `${kind} field ${key} must contain only strings`,
            "invalid_schema",
            "error",
            path,
        ),
    );
    return [];
}

export function claudeStringMap(
    parsed: ParsedClaudeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Skill",
): Record<string, string> | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = frontmatterStringMap(parsed, key);
    if (value !== undefined) return value;
    diagnostics.push(
        readDiagnostic(
            `claudecode.${kind.toLowerCase()}_${key.toLowerCase()}_invalid`,
            `${kind} field ${key} must be a string map`,
            "invalid_schema",
            "error",
            path,
        ),
    );
    return {};
}

/** Mirrors Claude's permission-list coercion without widening malformed input to all tools. */
export function claudeToolStrings(
    parsed: ParsedClaudeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Skill" | "Subagent",
): string[] | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = parsed.values[key];
    if (typeof value === "string") return splitDelimited(value);
    if (Array.isArray(value)) {
        const strings = value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item !== "");
        if (strings.length !== value.length) {
            diagnostics.push(
                readDiagnostic(
                    `claudecode.${kind.toLowerCase()}_${key.toLowerCase()}_filtered`,
                    `${kind} field ${key} contained non-string tool selectors; Claude and OAAM ignore those entries`,
                    "invalid_schema",
                    "warning",
                    path,
                ),
            );
        }
        return strings;
    }
    diagnostics.push(
        readDiagnostic(
            `claudecode.${kind.toLowerCase()}_${key.toLowerCase()}_empty_fallback`,
            `${kind} field ${key} is malformed; Claude and OAAM treat it as an empty permission list`,
            "invalid_schema",
            "warning",
            path,
        ),
    );
    return [];
}

/** Claude's Subagent parser treats any `*` selector as its undefined/all sentinel. */
export function claudeAgentToolStrings(
    parsed: ParsedClaudeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Subagent",
): string[] | undefined {
    const values = claudeToolStrings(parsed, key, diagnostics, path, kind);
    return values?.includes("*") ? undefined : values;
}

/** Mirrors Claude's positive-integer parser, including numeric strings. */
export function claudePositiveInt(parsed: ParsedClaudeFrontmatter, key: string): number | undefined {
    const value = parsed.values[key];
    if (value === undefined || value === null) return undefined;
    const parsedValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);
    return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}

export function claudeWorkflowShell(
    parsed: ParsedClaudeFrontmatter,
    diagnostics: OperationDiagnostic[],
    path: string,
): "bash" | "powershell" {
    const raw = parsed.values.shell;
    if (raw === undefined || raw === null) return "bash";
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === "" || normalized === "bash") return "bash";
    if (normalized === "powershell") return "powershell";
    diagnostics.push(
        readDiagnostic(
            "claudecode.workflow_shell_fallback",
            "Claude Code falls back to bash for an unrecognized Workflow shell selector",
            "invalid_schema",
            "warning",
            path,
        ),
    );
    return "bash";
}

export function isClaudeRuntimeNativeAgent(selector: string): boolean {
    return CLAUDE_RUNTIME_NATIVE_AGENTS.has(selector);
}

export function claudeForkContext(
    parsed: ParsedClaudeFrontmatter,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Skill",
): boolean {
    if (!parsed.presentKeys.includes("context")) return false;
    const value = parsed.values.context;
    if (value === null || value === "" || value === "inline") return false;
    if (value === "fork") return true;
    diagnostics.push(
        readDiagnostic(
            `claudecode.${kind.toLowerCase()}_context_invalid`,
            `${kind} context must be inline or fork`,
            "invalid_schema",
            "error",
            path,
        ),
    );
    return false;
}

export function claudeExecutionAgent(
    parsed: ParsedClaudeFrontmatter,
    isolated: boolean,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Skill",
): string | undefined {
    if (!parsed.presentKeys.includes("agent")) return undefined;
    const rawAgent = nonBlank(frontmatterString(parsed, "agent"));
    if (rawAgent === undefined) {
        diagnostics.push(
            readDiagnostic(
                `claudecode.${kind.toLowerCase()}_agent_invalid`,
                `${kind} agent must be a non-empty string`,
                "invalid_schema",
                "error",
                path,
            ),
        );
        return undefined;
    }
    if (!isolated) {
        diagnostics.push(
            readDiagnostic(
                `claudecode.${kind.toLowerCase()}_agent_without_fork`,
                `${kind} agent selection requires context: fork`,
                "invalid_schema",
                "error",
                path,
            ),
        );
    }
    return rawAgent;
}
