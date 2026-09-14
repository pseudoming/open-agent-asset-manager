/** ZCode declaration fields projected without executing runtime content. */

import type { OperationDiagnostic, SubagentTypeDataV2, ToolSelectorV1, WorkflowModelSelectionV1 } from "@oaam/core";
import { projectBoundedFrontmatterDiagnostics, type ParsedBoundedFrontmatter } from "@oaam/adapter-framework";
import { frontmatterBoolean, frontmatterNumber, frontmatterString } from "./zcode-frontmatter";
import { nonBlank, readDiagnostic } from "./zcode-source-read-foundation";

export const ZCODE_COMMAND_TOOL_DIALECT = "zcode-command-tool-selector-v1";
export const ZCODE_SUBAGENT_TOOL_DIALECT = "zcode-subagent-tool-name-v1";
export const ZCODE_MODEL_DIALECT = "zcode-model-selector-v1";
export const ZCODE_PERMISSION_DIALECT = "zcode-permission-mode-v1";
export const ZCODE_TURN_LIMIT_DIALECT = "zcode-max-turns-v1";
export const ZCODE_COLOR_DIALECT = "zcode-color-v1";

const ZCODE_COLORS = new Set(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);

export function isZcodeColor(value: string): boolean {
    return ZCODE_COLORS.has(value);
}

export function isZcodeSubagentToolName(value: string): boolean {
    const trimmed = value.trim();
    return trimmed !== "" && baseToolName(trimmed) === trimmed;
}

export function frontmatterDiagnostics(
    parsed: ParsedBoundedFrontmatter,
    kind: "Workflow" | "Subagent",
    path: string,
): OperationDiagnostic[] {
    return projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                `zcode.${kind.toLowerCase()}_frontmatter_unclosed`,
                `${kind} frontmatter is not closed`,
                "invalid_schema",
                "error",
                path,
            ),
        (message) => readDiagnostic(`zcode.${kind.toLowerCase()}_frontmatter_invalid`, message, "invalid_schema", "error", path),
    );
}

export function unknownFieldDiagnostic(kind: "Workflow" | "Subagent", fields: string[], path: string): OperationDiagnostic {
    return readDiagnostic(
        `zcode.${kind.toLowerCase()}_frontmatter_semantics_unsupported`,
        `${kind} frontmatter fields have no lossless canonical owner: ${fields.join(", ")}`,
        "unsupported",
        "error",
        path,
    );
}

export function optionalString(
    parsed: ParsedBoundedFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Subagent",
): string | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = frontmatterString(parsed, key);
    if (value !== undefined) return value;
    diagnostics.push(typeMismatchDiagnostic(kind, key, "a string", path, "warning"));
    return undefined;
}

export function optionalBoolean(
    parsed: ParsedBoundedFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Subagent",
): boolean | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = frontmatterBoolean(parsed, key);
    if (value !== undefined) return value;
    const raw = frontmatterString(parsed, key)?.toLowerCase();
    if (raw === "true" || (kind === "Workflow" && raw === "yes")) return true;
    if (raw === "false" || kind === "Workflow") return false;
    diagnostics.push(typeMismatchDiagnostic(kind, key, "a boolean", path, "warning"));
    return undefined;
}

export function stringList(
    parsed: ParsedBoundedFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: "Workflow" | "Subagent",
): string[] | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const raw = parsed.values[key];
    let values: string[] | undefined;
    if (typeof raw === "string") values = splitRuntimeList(raw);
    else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
        values = raw.map((item) => String(item).trim()).filter((item) => item !== "");
    }
    if (values !== undefined) return unique(values);
    diagnostics.push(typeMismatchDiagnostic(kind, key, "a string or string list", path, "error"));
    return [];
}

export function workflowToolSelectors(values: string[]): ToolSelectorV1[] {
    return unique(values.map((value) => value.trim()).filter((value) => value !== "")).map((selector) => ({
        dialectId: ZCODE_COMMAND_TOOL_DIALECT,
        selector,
    }));
}

export function subagentToolSelectors(values: string[]): ToolSelectorV1[] {
    return unique(values.map(baseToolName).filter((value) => value !== "")).map((selector) => ({
        dialectId: ZCODE_SUBAGENT_TOOL_DIALECT,
        selector,
    }));
}

export function commandCommaList(
    parsed: ParsedBoundedFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string[] | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const raw = frontmatterString(parsed, key);
    if (raw === undefined) {
        diagnostics.push(typeMismatchDiagnostic("Workflow", key, "a comma-separated string", path, "error"));
        return [];
    }
    const unwrapped = raw.replace(/^\[/, "").replace(/\]$/, "");
    return unique(
        unwrapped
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value !== ""),
    );
}

export function modelSelection(raw: string | undefined): WorkflowModelSelectionV1 {
    const selector = nonBlank(raw);
    return selector === undefined || selector === "inherit"
        ? { mode: "inherit" }
        : { mode: "selected", dialectId: ZCODE_MODEL_DIALECT, selector, relativeTier: -1 };
}

export function permissionPolicy(
    raw: string | undefined,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["execution"]["permission"] {
    const selector = nonBlank(raw);
    if (selector === undefined) return { mode: "inherit" };
    const effects: Record<string, Exclude<SubagentTypeDataV2["execution"]["permission"], { mode: "inherit" }>["effect"]> = {
        acceptEdits: "auto_approve_selected_operations",
        auto: "classifier_mediated",
        bypassPermissions: "bypass_permission_checks",
        default: "interactive",
        dontAsk: "auto_deny_unapproved",
        plan: "read_only",
    };
    const effect = effects[selector];
    if (effect === undefined) {
        diagnostics.push(
            readDiagnostic(
                "zcode.subagent_permission_ignored",
                "ZCode ignores an unknown Subagent permissionMode; OAAM preserved the native field and inherited policy",
                "invalid_schema",
                "warning",
                path,
            ),
        );
        return { mode: "inherit" };
    }
    return { mode: "selected", dialectId: ZCODE_PERMISSION_DIALECT, selector, effect };
}

export function positiveTurnLimit(
    parsed: ParsedBoundedFrontmatter,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["execution"]["turnLimit"] {
    if (!parsed.presentKeys.includes("maxTurns")) return { mode: "agent_runtime_default" };
    const numeric = frontmatterNumber(parsed, "maxTurns");
    const text = frontmatterString(parsed, "maxTurns");
    const value = numeric ?? parsePositiveIntegerText(text);
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
        diagnostics.push(typeMismatchDiagnostic("Subagent", "maxTurns", "a positive safe integer", path, "warning"));
        return { mode: "agent_runtime_default" };
    }
    return { mode: "bounded", dialectId: ZCODE_TURN_LIMIT_DIALECT, limit: value };
}

export function colorSelection(
    raw: string | undefined,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["presentation"]["color"] {
    const selector = nonBlank(raw);
    if (selector === undefined) return { mode: "agent_runtime_default" };
    if (!isZcodeColor(selector)) {
        diagnostics.push(
            readDiagnostic(
                "zcode.subagent_color_ignored",
                "ZCode ignores an unknown Subagent color; OAAM preserved the native field and omitted the canonical selector",
                "invalid_schema",
                "warning",
                path,
            ),
        );
        return { mode: "agent_runtime_default" };
    }
    return { mode: "selected", dialectId: ZCODE_COLOR_DIALECT, selector };
}

export function commandArgumentNames(body: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "$") continue;
        if (body.startsWith("$ARGUMENTS", index)) {
            values.push("ARGUMENTS");
            index += "$ARGUMENTS".length - 1;
            continue;
        }
        let end = index + 1;
        while (end < body.length && isDigit(body[end] ?? "")) end += 1;
        if (end > index + 1) {
            values.push(body.slice(index + 1, end));
            index = end - 1;
        }
    }
    return unique(values);
}

export function containsUnsupportedShellExpansion(body: string): boolean {
    if (body.includes("!`")) return true;
    let cursor = 0;
    while (true) {
        cursor = body.indexOf("```", cursor);
        if (cursor === -1) break;
        let next = cursor + 3;
        while (body[next] === " " || body[next] === "\t") next += 1;
        if (body[next] === "!") return true;
        cursor += 3;
    }
    return false;
}

export function fallbackDescription(body: string): string {
    for (const line of body.split("\n")) {
        let value = line.trim();
        if (value === "") continue;
        while (value.startsWith("#")) value = value.slice(1).trimStart();
        if (value.startsWith("-") || value.startsWith("*")) value = value.slice(1).trimStart();
        return value.slice(0, 1024);
    }
    return "";
}

function splitRuntimeList(value: string): string[] {
    const result: string[] = [];
    let current = "";
    let depth = 0;
    for (const character of value) {
        if (character === "(") depth += 1;
        else if (character === ")" && depth > 0) depth -= 1;
        if (depth === 0 && (character === "," || isWhitespace(character))) {
            if (current.trim() !== "") result.push(current.trim());
            current = "";
        } else current += character;
    }
    if (current.trim() !== "") result.push(current.trim());
    return result;
}

function parsePositiveIntegerText(value: string | undefined): number | undefined {
    if (value === undefined || value === "" || [...value].some((character) => !isDigit(character))) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function baseToolName(value: string): string {
    const open = value.indexOf("(");
    return open < 0 ? value : value.slice(0, open).trim();
}

function typeMismatchDiagnostic(
    kind: "Workflow" | "Subagent",
    key: string,
    expected: string,
    path: string,
    severity: "warning" | "error",
): OperationDiagnostic {
    return readDiagnostic(
        `zcode.${kind.toLowerCase()}_${key.toLowerCase()}_invalid`,
        `${kind} field ${key} must be ${expected}`,
        "invalid_schema",
        severity,
        path,
    );
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function isDigit(value: string): boolean {
    return value >= "0" && value <= "9";
}

function isWhitespace(value: string): boolean {
    return value === " " || value === "\t" || value === "\n" || value === "\r";
}
