/** Current ZCode Markdown Subagent projection and lossless native editing. */

import { stableSourceValueEqual } from "@oaam/adapter-framework";
import type { AssetKindTypeDataV2, SubagentInstructionEntryV1, SubagentTypeDataV2 } from "@oaam/core";
import { parseZcodeSubagentFrontmatter } from "./zcode-frontmatter";
import {
    isZcodeColor,
    isZcodeSubagentToolName,
    ZCODE_COLOR_DIALECT,
    ZCODE_MODEL_DIALECT,
    ZCODE_PERMISSION_DIALECT,
    ZCODE_SUBAGENT_TOOL_DIALECT,
    ZCODE_TURN_LIMIT_DIALECT,
} from "./zcode-source-read-fields";

type SubagentCanonical = Extract<AssetKindTypeDataV2, { kind: "Subagent" }>;
export type ZcodeSubagentScope = "project" | "global";

const PERMISSION_EFFECTS = {
    acceptEdits: "auto_approve_selected_operations",
    auto: "classifier_mediated",
    bypassPermissions: "bypass_permission_checks",
    default: "interactive",
    dontAsk: "auto_deny_unapproved",
    plan: "read_only",
} as const satisfies Record<string, Exclude<SubagentTypeDataV2["execution"]["permission"], { mode: "inherit" }>["effect"]>;

const SUPPORTED_FIELDS = new Set([
    "background",
    "color",
    "description",
    "disallowedTools",
    "maxTurns",
    "model",
    "name",
    "permissionMode",
    "tools",
]);

export interface ZcodeMarkdownSubagentProjection {
    name: string;
    description: string;
    body: string;
    tools: string[] | undefined;
    disallowedTools: string[] | undefined;
    model: string | undefined;
    permissionMode: keyof typeof PERMISSION_EFFECTS | undefined;
    maxTurns: number | undefined;
    background: boolean | undefined;
    color: string | undefined;
}

type FrontmatterRewriteValue = boolean | number | string | readonly string[];

export function projectZcodeMarkdownSubagentCanonical(
    canonical: SubagentCanonical,
    entryText: string,
    scope: ZcodeSubagentScope,
): ZcodeMarkdownSubagentProjection | null {
    const body = parseInstructionBody(entryText);
    const tools = projectTools(canonical.typeData, "allowed");
    const disallowedTools = projectTools(canonical.typeData, "unavailable");
    const model = projectModel(canonical.typeData);
    const permissionMode = projectPermission(canonical.typeData, scope);
    const maxTurns = projectTurnLimit(canonical.typeData);
    const background = projectScheduling(canonical.typeData);
    const color = projectColor(canonical.typeData);
    if (
        body === null ||
        tools === null ||
        disallowedTools === null ||
        model === null ||
        permissionMode === null ||
        maxTurns === null ||
        background === null ||
        color === null ||
        !hasSupportedEnvelope(canonical.typeData) ||
        !isSafeScalar(canonical.typeData.name) ||
        !isSafeDescription(canonical.typeData.description)
    ) {
        return null;
    }
    return {
        name: canonical.typeData.name,
        description: canonical.typeData.description,
        body,
        tools,
        disallowedTools,
        model,
        permissionMode,
        maxTurns,
        background,
        color,
    };
}

export function serializeZcodeMarkdownSubagent(projection: ZcodeMarkdownSubagentProjection): string {
    const lines = ["---", `name: ${JSON.stringify(projection.name)}`, `description: ${JSON.stringify(projection.description)}`];
    if (projection.tools !== undefined) lines.push(`tools: ${JSON.stringify(projection.tools)}`);
    if (projection.disallowedTools !== undefined) {
        lines.push(`disallowedTools: ${JSON.stringify(projection.disallowedTools)}`);
    }
    if (projection.model !== undefined) lines.push(`model: ${JSON.stringify(projection.model)}`);
    if (projection.permissionMode !== undefined) lines.push(`permissionMode: ${projection.permissionMode}`);
    if (projection.maxTurns !== undefined) lines.push(`maxTurns: ${String(projection.maxTurns)}`);
    if (projection.background !== undefined) lines.push(`background: ${projection.background ? "true" : "false"}`);
    if (projection.color !== undefined) lines.push(`color: ${projection.color}`);
    return `${lines.join("\n")}\n---\n${projection.body}`;
}

export function rebaseZcodeMarkdownSubagent(
    parentText: string,
    projection: ZcodeMarkdownSubagentProjection,
    scope: ZcodeSubagentScope,
): string | null {
    const current = parseNativeProjection(parentText, scope);
    if (current === null) return null;
    const desired = projectionFields(projection, scope);
    const currentValues = projectionFields(current, scope);
    const rewrittenPrefix = rewriteFrontmatter(parentText, desired, currentValues);
    return rewrittenPrefix === null ? null : `${rewrittenPrefix}${projection.body}`;
}

export function reverseZcodeMarkdownSubagent(appliedText: string, currentText: string): string | null {
    const applied = splitDocument(appliedText);
    const current = splitDocument(currentText);
    if (applied === null || current === null || applied.prefix !== current.prefix) return null;
    const instruction: SubagentInstructionEntryV1 = {
        schemaVersion: 1,
        sections: [{ title: "", content: current.body.trim() }],
    };
    return instruction.sections[0]?.content === "" ? null : JSON.stringify(instruction);
}

function parseNativeProjection(text: string, scope: ZcodeSubagentScope): ZcodeMarkdownSubagentProjection | null {
    const parsed = parseZcodeSubagentFrontmatter(text);
    if (
        !parsed.hasFrontmatter ||
        !parsed.closed ||
        parsed.diagnostics.length !== 0 ||
        parsed.presentKeys.some((key) => !SUPPORTED_FIELDS.has(key)) ||
        parsed.body.trim() === ""
    ) {
        return null;
    }
    const name = scalar(parsed.values.name);
    const rawDescription = scalar(parsed.values.description);
    const tools = list(parsed.values.tools);
    const disallowedTools = list(parsed.values.disallowedTools);
    const model = scalar(parsed.values.model);
    const permissionMode = scalar(parsed.values.permissionMode);
    const maxTurns = positiveInteger(parsed.values.maxTurns);
    const background = booleanValue(parsed.values.background);
    const color = scalar(parsed.values.color);
    if (
        name === null ||
        rawDescription === null ||
        tools === null ||
        disallowedTools === null ||
        model === null ||
        permissionMode === null ||
        maxTurns === null ||
        background === null ||
        color === null
    ) {
        return null;
    }
    if (name === undefined || name.trim() === "" || rawDescription === undefined || rawDescription.trim() === "") return null;
    return {
        name,
        description: rawDescription.split("\\n").join("\n"),
        body: parsed.body,
        tools,
        disallowedTools,
        model: model === "inherit" ? undefined : model,
        permissionMode:
            scope === "project" || permissionMode === undefined
                ? undefined
                : PERMISSION_EFFECTS[permissionMode as keyof typeof PERMISSION_EFFECTS] === undefined
                  ? undefined
                  : (permissionMode as keyof typeof PERMISSION_EFFECTS),
        maxTurns,
        background,
        color: color !== undefined && isZcodeColor(color) ? color : undefined,
    };
}

function projectionFields(
    projection: ZcodeMarkdownSubagentProjection,
    scope: ZcodeSubagentScope,
): Map<string, FrontmatterRewriteValue | undefined> {
    const values = new Map<string, FrontmatterRewriteValue | undefined>([
        ["name", projection.name],
        ["description", projection.description],
        ["tools", projection.tools],
        ["disallowedTools", projection.disallowedTools],
        ["model", projection.model],
        ["maxTurns", projection.maxTurns],
        ["background", projection.background],
        ["color", projection.color],
    ]);
    if (scope === "global") values.set("permissionMode", projection.permissionMode);
    return values;
}

function projectTools(typeData: SubagentTypeDataV2, kind: "allowed" | "unavailable"): string[] | undefined | null {
    if (typeData.tools.permission.rules.length !== 0 || typeData.tools.permission.otherwise !== "inherit_agent_runtime_policy") {
        return null;
    }
    const values =
        kind === "allowed"
            ? typeData.tools.availability.base.mode === "inherit_available"
                ? undefined
                : typeData.tools.availability.base.mode === "allowlist"
                  ? typeData.tools.availability.base.allowed
                  : null
            : typeData.tools.availability.unavailable;
    if (values === null) return null;
    const projected: string[] = [];
    for (const value of values ?? []) {
        if (
            value.mode !== "agent_runtime_tool" ||
            value.selector.dialectId !== ZCODE_SUBAGENT_TOOL_DIALECT ||
            !isZcodeSubagentToolName(value.selector.selector) ||
            !isSafeScalar(value.selector.selector)
        ) {
            return null;
        }
        projected.push(value.selector.selector);
    }
    return values === undefined ? undefined : unique(projected);
}

function projectModel(typeData: SubagentTypeDataV2): string | undefined | null {
    const model = typeData.execution.model;
    if (model.mode === "inherit") return undefined;
    return model.dialectId === ZCODE_MODEL_DIALECT && model.relativeTier === -1 && isSafeScalar(model.selector)
        ? model.selector
        : null;
}

function projectPermission(
    typeData: SubagentTypeDataV2,
    scope: ZcodeSubagentScope,
): keyof typeof PERMISSION_EFFECTS | undefined | null {
    const permission = typeData.execution.permission;
    if (permission.mode === "inherit") return undefined;
    if (scope === "project" || permission.dialectId !== ZCODE_PERMISSION_DIALECT) return null;
    const effect = PERMISSION_EFFECTS[permission.selector as keyof typeof PERMISSION_EFFECTS];
    return effect === permission.effect ? (permission.selector as keyof typeof PERMISSION_EFFECTS) : null;
}

function projectTurnLimit(typeData: SubagentTypeDataV2): number | undefined | null {
    const turnLimit = typeData.execution.turnLimit;
    if (turnLimit.mode === "agent_runtime_default") return undefined;
    return turnLimit.dialectId === ZCODE_TURN_LIMIT_DIALECT && Number.isSafeInteger(turnLimit.limit) && turnLimit.limit > 0
        ? turnLimit.limit
        : null;
}

function projectScheduling(typeData: SubagentTypeDataV2): boolean | undefined | null {
    const scheduling = typeData.execution.scheduling;
    if (scheduling.mode === "agent_runtime_default") return undefined;
    if (scheduling.mode === "always_background") return true;
    if (scheduling.mode === "always_foreground") return false;
    return null;
}

function projectColor(typeData: SubagentTypeDataV2): string | undefined | null {
    const color = typeData.presentation.color;
    if (color.mode === "agent_runtime_default") return undefined;
    return color.dialectId === ZCODE_COLOR_DIALECT && isZcodeColor(color.selector) ? color.selector : null;
}

function hasSupportedEnvelope(typeData: SubagentTypeDataV2): boolean {
    return (
        typeData.schemaVersion === 2 &&
        typeData.name.trim() !== "" &&
        typeData.description.trim() !== "" &&
        stableSourceValueEqual(typeData.promptContextPolicy, { mode: "agent_runtime_default" }) &&
        typeData.dependencies.preloadedSkillVersionIds.length === 0 &&
        stableSourceValueEqual(typeData.memory, { mode: "disabled" }) &&
        stableSourceValueEqual(typeData.execution.workspaceIsolation, { mode: "agent_runtime_default" }) &&
        stableSourceValueEqual(typeData.execution.effort, { mode: "inherit" }) &&
        stableSourceValueEqual(typeData.execution.sampling, {
            temperature: { mode: "agent_runtime_default" },
            topP: { mode: "agent_runtime_default" },
        }) &&
        typeData.directInvocation.mode === "delegated_only" &&
        typeData.presentation.listing === "visible"
    );
}

function parseInstructionBody(text: string): string | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(value) || Object.keys(value).sort().join("\0") !== "schemaVersion\0sections" || value.schemaVersion !== 1) {
        return null;
    }
    if (!Array.isArray(value.sections) || value.sections.length !== 1) return null;
    const section = value.sections[0];
    return isRecord(section) &&
        Object.keys(section).sort().join("\0") === "content\0title" &&
        section.title === "" &&
        typeof section.content === "string" &&
        section.content.trim() !== ""
        ? section.content
        : null;
}

interface FrontmatterField {
    start: number;
    end: number;
    valueStart: number;
    valueEnd: number;
    multiline: boolean;
    containsComment: boolean;
}

function rewriteFrontmatter(
    parentText: string,
    desired: Map<string, FrontmatterRewriteValue | undefined>,
    current: Map<string, FrontmatterRewriteValue | undefined>,
): string | null {
    const document = splitDocument(parentText);
    if (document === null) return null;
    const scanned = scanFrontmatterFields(document.prefix);
    if (scanned === null) return null;
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    for (const [key, desiredValue] of desired) {
        if (stableSourceValueEqual(desiredValue, current.get(key))) continue;
        const field = scanned.fields.get(key);
        if (field === undefined) {
            if (desiredValue !== undefined) {
                edits.push({
                    start: scanned.closingStart,
                    end: scanned.closingStart,
                    replacement: `${key}: ${serializeFieldValue(desiredValue)}\n`,
                });
            }
        } else if (desiredValue === undefined) {
            if (field.containsComment) return null;
            edits.push({ start: field.start, end: field.end, replacement: "" });
        } else if (field.multiline) {
            if (field.containsComment) return null;
            edits.push({ start: field.start, end: field.end, replacement: `${key}: ${serializeFieldValue(desiredValue)}\n` });
        } else {
            edits.push({ start: field.valueStart, end: field.valueEnd, replacement: serializeFieldValue(desiredValue) });
        }
    }
    let prefix = document.prefix;
    for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
        prefix = `${prefix.slice(0, edit.start)}${edit.replacement}${prefix.slice(edit.end)}`;
    }
    return prefix;
}

function scanFrontmatterFields(prefix: string): { fields: Map<string, FrontmatterField>; closingStart: number } | null {
    const lines = lineSpans(prefix);
    if (lines[0]?.text !== "---") return null;
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.text === "---");
    if (closingIndex < 1) return null;
    const fields = new Map<string, FrontmatterField>();
    for (let index = 1; index < closingIndex; index += 1) {
        const line = lines[index];
        if (line === undefined || line.text.trim() === "" || line.text.trimStart().startsWith("#") || /^\s/u.test(line.text)) {
            continue;
        }
        const separator = line.text.indexOf(":");
        if (separator <= 0) continue;
        const key = line.text.slice(0, separator).trim();
        let endIndex = index + 1;
        while (endIndex < closingIndex && /^\s/u.test(lines[endIndex]?.text ?? "")) endIndex += 1;
        const block = lines.slice(index, endIndex);
        const rawValue = line.text.slice(separator + 1);
        const commentOffset = trailingCommentOffset(rawValue);
        const leading = rawValue.length - rawValue.trimStart().length;
        const valueStart = line.start + separator + 1 + leading;
        const rawEnd = commentOffset < 0 ? rawValue.length : commentOffset;
        const valueEnd = line.start + separator + 1 + rawValue.slice(0, rawEnd).trimEnd().length;
        fields.set(key, {
            start: line.start,
            end: (lines[endIndex - 1] as LineSpan).end,
            valueStart,
            valueEnd,
            multiline: block.length > 1,
            containsComment: block.some((item) => item.text.trimStart().startsWith("#") || trailingCommentOffset(item.text) >= 0),
        });
        index = endIndex - 1;
    }
    return { fields, closingStart: (lines[closingIndex] as LineSpan).start };
}

interface LineSpan {
    text: string;
    start: number;
    end: number;
}

function lineSpans(value: string): LineSpan[] {
    const result: LineSpan[] = [];
    let start = 0;
    while (start < value.length) {
        const newline = value.indexOf("\n", start);
        const end = newline < 0 ? value.length : newline + 1;
        result.push({ text: value.slice(start, newline < 0 ? value.length : newline), start, end });
        start = end;
    }
    return result;
}

function trailingCommentOffset(value: string): number {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) escaped = false;
        else if (quote !== null) {
            if (character === "\\" && quote === '"') escaped = true;
            else if (character === quote) quote = null;
        } else if (character === "'" || character === '"') quote = character;
        else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] as string))) return index;
    }
    return -1;
}

function serializeFieldValue(value: FrontmatterRewriteValue): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    return JSON.stringify(value);
}

function splitDocument(text: string): { prefix: string; body: string } | null {
    const parsed = parseZcodeSubagentFrontmatter(text);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    return { prefix: text.slice(0, text.length - parsed.body.length), body: parsed.body };
}

function scalar(value: unknown): string | undefined | null {
    return value === undefined ? undefined : typeof value === "string" ? value.trim() : null;
}

function list(value: unknown): string[] | undefined | null {
    if (value === undefined) return undefined;
    const values =
        typeof value === "string"
            ? value.split(/[\s,]+/u).filter((item) => item !== "")
            : Array.isArray(value) && value.every((item) => typeof item === "string")
              ? value.map((item) => item.trim()).filter((item) => item !== "")
              : null;
    return values === null ? null : unique(values);
}

function positiveInteger(value: unknown): number | undefined | null {
    if (value === undefined) return undefined;
    const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function booleanValue(value: unknown): boolean | undefined | null {
    return value === undefined ? undefined : typeof value === "boolean" ? value : null;
}

function isSafeScalar(value: string): boolean {
    return value.trim() !== "" && !value.includes("\\") && !value.includes('"') && !value.includes("\n") && !value.includes("\r");
}

function isSafeDescription(value: string): boolean {
    return value.trim() !== "" && !value.includes("\\") && !value.includes('"') && !value.includes("\r");
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
