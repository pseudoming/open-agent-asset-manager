/** Current Cursor project Subagent semantics and lossless native editing. */

import { projectBoundedFrontmatterDiagnostics, stableSourceValueEqual } from "@oaam/adapter-framework";
import type { AssetKindTypeDataV2, OperationDiagnostic, SubagentInstructionEntryV1, SubagentTypeDataV2 } from "@oaam/core";
import { cursorFrontmatterBoolean, cursorFrontmatterString, parseCursorFrontmatter } from "./cursor-frontmatter";
import { nonBlank, readDiagnostic } from "./cursor-source-read-foundation";

type SubagentCanonical = Extract<AssetKindTypeDataV2, { kind: "Subagent" }>;

export const CURSOR_SUBAGENT_TOOL_DIALECT = "cursor-subagent-tool-name-v1";
export const CURSOR_SUBAGENT_MODEL_DIALECT = "cursor-subagent-model-selector-v1";
export const CURSOR_SUBAGENT_PERMISSION_DIALECT = "cursor-subagent-readonly-v1";

const SUPPORTED_KEYS = new Set([
    "background",
    "description",
    "force-default-model",
    "is_background",
    "model",
    "name",
    "readonly",
    "tools",
]);

export interface CursorMarkdownSubagentProjection {
    name: string;
    description: string;
    body: string;
    tools: string[] | undefined;
    model: string | undefined;
    readonly: boolean | undefined;
    background: boolean | undefined;
    backgroundKey: "background" | "is_background";
    typeData: SubagentTypeDataV2;
}

export type ParsedCursorMarkdownSubagent =
    | {
          disposition: "candidate";
          name: string;
          description: string;
          instruction: SubagentInstructionEntryV1;
          typeData: SubagentTypeDataV2;
          projection: CursorMarkdownSubagentProjection;
          diagnostics: OperationDiagnostic[];
      }
    | { disposition: "ignored"; diagnostics: OperationDiagnostic[] };

type RewriteValue = boolean | string | readonly string[];

export function parseCursorMarkdownSubagent(text: string, relativePath: string): ParsedCursorMarkdownSubagent {
    const parsed = parseCursorFrontmatter(text);
    const diagnostics = projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "cursor.subagent_frontmatter_unclosed",
                "Cursor Subagent frontmatter is not closed",
                "invalid_schema",
                "error",
                relativePath,
            ),
        (message) => readDiagnostic("cursor.subagent_frontmatter_invalid", message, "invalid_schema", "error", relativePath),
    );
    const name = nonBlank(cursorFrontmatterString(parsed, "name"));
    const description = nonBlank(cursorFrontmatterString(parsed, "description"));
    const body = parsed.body;
    if (!parsed.hasFrontmatter || !parsed.closed || name === undefined || description === undefined || body.trim() === "") {
        return {
            disposition: "ignored",
            diagnostics: [
                ...diagnostics,
                readDiagnostic(
                    "cursor.subagent_required_content_missing",
                    "Cursor Subagent requires closed frontmatter, non-empty name and description, and a non-empty prompt body",
                    "invalid_schema",
                    "error",
                    relativePath,
                ),
            ],
        };
    }
    const unknown = parsed.presentKeys.filter((key) => !SUPPORTED_KEYS.has(key));
    if (unknown.length > 0) {
        diagnostics.push(
            readDiagnostic(
                "cursor.subagent_frontmatter_semantics_unsupported",
                `Cursor Subagent fields have no lossless canonical owner: ${unknown.join(", ")}`,
                "unsupported",
                "error",
                relativePath,
            ),
        );
    }
    const tools = parseTools(parsed.values.tools, parsed.presentKeys.includes("tools"), diagnostics, relativePath);
    const model = optionalScalar(parsed.values.model, parsed.presentKeys.includes("model"), "model", diagnostics, relativePath);
    const readonly = optionalBoolean(parsed, "readonly", diagnostics, relativePath);
    const background = optionalBoolean(parsed, "background", diagnostics, relativePath);
    const legacyBackground = optionalBoolean(parsed, "is_background", diagnostics, relativePath);
    if (background !== undefined && legacyBackground !== undefined) {
        diagnostics.push(
            readDiagnostic(
                "cursor.subagent_background_alias_ambiguous",
                "Cursor Subagent cannot declare both background and is_background in one portable asset",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }
    const forceDefaultModel = optionalBoolean(parsed, "force-default-model", diagnostics, relativePath);
    if (forceDefaultModel === true) {
        diagnostics.push(
            readDiagnostic(
                "cursor.subagent_force_default_model_unmapped",
                "force-default-model changes Cursor model selection but has no lossless portable owner",
                "unsupported",
                "error",
                relativePath,
            ),
        );
    }
    const scheduling = background ?? legacyBackground;
    const typeData: SubagentTypeDataV2 = {
        schemaVersion: 2,
        name,
        description,
        promptContextPolicy: { mode: "agent_runtime_default" },
        tools: {
            availability: {
                base:
                    tools === undefined
                        ? { mode: "inherit_available" }
                        : tools.length === 0
                          ? { mode: "none" }
                          : {
                                mode: "allowlist",
                                allowed: tools.map((selector) => ({
                                    mode: "agent_runtime_tool" as const,
                                    selector: { dialectId: CURSOR_SUBAGENT_TOOL_DIALECT, selector },
                                })),
                            },
                unavailable: [],
            },
            permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
        },
        dependencies: { preloadedSkillVersionIds: [] },
        memory: { mode: "disabled" },
        execution: {
            permission:
                readonly === true
                    ? {
                          mode: "selected",
                          dialectId: CURSOR_SUBAGENT_PERMISSION_DIALECT,
                          selector: "readonly",
                          effect: "read_only",
                      }
                    : { mode: "inherit" },
            workspaceIsolation: { mode: "agent_runtime_default" },
            scheduling:
                scheduling === true
                    ? { mode: "always_background" }
                    : scheduling === false
                      ? { mode: "always_foreground" }
                      : { mode: "agent_runtime_default" },
            turnLimit: { mode: "agent_runtime_default" },
            model:
                model === undefined || model === "inherit"
                    ? { mode: "inherit" }
                    : { mode: "selected", dialectId: CURSOR_SUBAGENT_MODEL_DIALECT, selector: model, relativeTier: -1 },
            effort: { mode: "inherit" },
            sampling: {
                temperature: { mode: "agent_runtime_default" },
                topP: { mode: "agent_runtime_default" },
            },
        },
        directInvocation: { mode: "delegated_only" },
        presentation: { listing: "visible", color: { mode: "agent_runtime_default" } },
    };
    const instruction: SubagentInstructionEntryV1 = {
        schemaVersion: 1,
        sections: [{ title: "", content: body }],
    };
    return {
        disposition: "candidate",
        name,
        description,
        instruction,
        typeData,
        projection: {
            name,
            description,
            body: parsed.body,
            tools,
            model: model === "inherit" ? undefined : model,
            readonly,
            background: scheduling,
            backgroundKey: background === undefined && legacyBackground !== undefined ? "is_background" : "background",
            typeData,
        },
        diagnostics,
    };
}

export function projectCursorMarkdownSubagentCanonical(
    canonical: SubagentCanonical,
    entryText: string,
): CursorMarkdownSubagentProjection | null {
    const body = parseInstructionBody(entryText);
    const tools = projectTools(canonical.typeData);
    const model = projectModel(canonical.typeData);
    const readonly = projectReadonly(canonical.typeData);
    const background = projectScheduling(canonical.typeData);
    if (
        body === null ||
        tools === null ||
        model === null ||
        readonly === null ||
        background === null ||
        !hasSupportedEnvelope(canonical.typeData) ||
        !isSafeText(canonical.typeData.name) ||
        !isSafeText(canonical.typeData.description)
    ) {
        return null;
    }
    return {
        name: canonical.typeData.name,
        description: canonical.typeData.description,
        body,
        tools,
        model,
        readonly,
        background,
        backgroundKey: "background",
        typeData: canonical.typeData,
    };
}

export function serializeCursorMarkdownSubagent(projection: CursorMarkdownSubagentProjection): string {
    const lines = ["---", `name: ${JSON.stringify(projection.name)}`, `description: ${JSON.stringify(projection.description)}`];
    if (projection.tools !== undefined) lines.push(`tools: ${JSON.stringify(projection.tools.join(", "))}`);
    if (projection.model !== undefined) lines.push(`model: ${JSON.stringify(projection.model)}`);
    if (projection.readonly !== undefined) lines.push(`readonly: ${projection.readonly ? "true" : "false"}`);
    if (projection.background !== undefined) lines.push(`background: ${projection.background ? "true" : "false"}`);
    return `${lines.join("\n")}\n---\n${projection.body}`;
}

export function rebaseCursorMarkdownSubagent(parentText: string, projection: CursorMarkdownSubagentProjection): string | null {
    const parent = parseCursorMarkdownSubagent(parentText, ".cursor/agents/parent.md");
    if (parent.disposition !== "candidate" || parent.diagnostics.some((item) => item.severity === "error")) return null;
    const desired = new Map<string, RewriteValue | undefined>([
        ["name", projection.name],
        ["description", projection.description],
        [
            "tools",
            stableSourceValueEqual(parent.typeData.tools, projection.typeData.tools)
                ? parent.projection.tools?.join(", ")
                : projection.tools?.join(", "),
        ],
        [
            "model",
            stableSourceValueEqual(parent.typeData.execution.model, projection.typeData.execution.model)
                ? parent.projection.model
                : projection.model,
        ],
        [
            "readonly",
            stableSourceValueEqual(parent.typeData.execution.permission, projection.typeData.execution.permission)
                ? parent.projection.readonly
                : projection.readonly,
        ],
        [
            parent.projection.backgroundKey,
            stableSourceValueEqual(parent.typeData.execution.scheduling, projection.typeData.execution.scheduling)
                ? parent.projection.background
                : projection.background,
        ],
    ]);
    const current = new Map<string, RewriteValue | undefined>([
        ["name", parent.projection.name],
        ["description", parent.projection.description],
        ["tools", parent.projection.tools?.join(", ")],
        ["model", parent.projection.model],
        ["readonly", parent.projection.readonly],
        [parent.projection.backgroundKey, parent.projection.background],
    ]);
    const prefix = rewriteFrontmatter(parentText, desired, current);
    return prefix === null ? null : `${prefix}${projection.body}`;
}

export function reverseCursorMarkdownSubagent(appliedText: string, currentText: string): string | null {
    const applied = splitDocument(appliedText);
    const current = splitDocument(currentText);
    if (applied === null || current === null || applied.prefix !== current.prefix) return null;
    const parsed = parseCursorMarkdownSubagent(currentText, ".cursor/agents/reverse.md");
    return parsed.disposition === "candidate" && parsed.diagnostics.every((item) => item.severity !== "error")
        ? JSON.stringify(parsed.instruction)
        : null;
}

export function isCursorSubagentToolName(value: string): boolean {
    const trimmed = value.trim();
    return trimmed !== "" && trimmed === value && !/[\0\r\n,]/u.test(value);
}

function parseTools(value: unknown, present: boolean, diagnostics: OperationDiagnostic[], path: string): string[] | undefined {
    if (!present) return undefined;
    if (typeof value !== "string") {
        diagnostics.push(fieldTypeDiagnostic("tools", "a comma-separated string", path));
        return [];
    }
    const tools = unique(
        value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== ""),
    );
    if (tools.some((item) => !isCursorSubagentToolName(item))) {
        diagnostics.push(fieldTypeDiagnostic("tools", "bounded tool names without commas or newlines", path));
    }
    return tools;
}

function optionalScalar(
    value: unknown,
    present: boolean,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string | undefined {
    if (!present) return undefined;
    if (typeof value === "string" && isSafeText(value.trim())) return value.trim();
    diagnostics.push(fieldTypeDiagnostic(key, "a non-empty string", path));
    return undefined;
}

function optionalBoolean(
    parsed: ReturnType<typeof parseCursorFrontmatter>,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): boolean | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = cursorFrontmatterBoolean(parsed, key);
    if (value === undefined) diagnostics.push(fieldTypeDiagnostic(key, "a boolean", path));
    return value;
}

function fieldTypeDiagnostic(key: string, expected: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        `cursor.subagent_${key.replaceAll("-", "_")}_invalid`,
        `Cursor Subagent field ${key} must be ${expected}`,
        "invalid_schema",
        "error",
        path,
    );
}

function projectTools(typeData: SubagentTypeDataV2): string[] | undefined | null {
    if (typeData.tools.availability.unavailable.length !== 0) return null;
    if (typeData.tools.permission.rules.length !== 0 || typeData.tools.permission.otherwise !== "inherit_agent_runtime_policy") {
        return null;
    }
    const base = typeData.tools.availability.base;
    if (base.mode === "inherit_available") return undefined;
    if (base.mode === "none") return [];
    const tools: string[] = [];
    for (const item of base.allowed) {
        if (
            item.mode !== "agent_runtime_tool" ||
            item.selector.dialectId !== CURSOR_SUBAGENT_TOOL_DIALECT ||
            !isCursorSubagentToolName(item.selector.selector)
        ) {
            return null;
        }
        tools.push(item.selector.selector);
    }
    return unique(tools);
}

function projectModel(typeData: SubagentTypeDataV2): string | undefined | null {
    const model = typeData.execution.model;
    if (model.mode === "inherit") return undefined;
    return model.dialectId === CURSOR_SUBAGENT_MODEL_DIALECT && model.relativeTier === -1 && isSafeText(model.selector)
        ? model.selector
        : null;
}

function projectReadonly(typeData: SubagentTypeDataV2): boolean | undefined | null {
    const permission = typeData.execution.permission;
    if (permission.mode === "inherit") return undefined;
    return permission.dialectId === CURSOR_SUBAGENT_PERMISSION_DIALECT &&
        permission.selector === "readonly" &&
        permission.effect === "read_only"
        ? true
        : null;
}

function projectScheduling(typeData: SubagentTypeDataV2): boolean | undefined | null {
    const scheduling = typeData.execution.scheduling;
    if (scheduling.mode === "agent_runtime_default") return undefined;
    if (scheduling.mode === "always_background") return true;
    if (scheduling.mode === "always_foreground") return false;
    return null;
}

function hasSupportedEnvelope(typeData: SubagentTypeDataV2): boolean {
    return (
        typeData.schemaVersion === 2 &&
        stableSourceValueEqual(typeData.promptContextPolicy, { mode: "agent_runtime_default" }) &&
        typeData.dependencies.preloadedSkillVersionIds.length === 0 &&
        stableSourceValueEqual(typeData.memory, { mode: "disabled" }) &&
        stableSourceValueEqual(typeData.execution.workspaceIsolation, { mode: "agent_runtime_default" }) &&
        stableSourceValueEqual(typeData.execution.turnLimit, { mode: "agent_runtime_default" }) &&
        stableSourceValueEqual(typeData.execution.effort, { mode: "inherit" }) &&
        stableSourceValueEqual(typeData.execution.sampling, {
            temperature: { mode: "agent_runtime_default" },
            topP: { mode: "agent_runtime_default" },
        }) &&
        typeData.directInvocation.mode === "delegated_only" &&
        typeData.presentation.listing === "visible" &&
        typeData.presentation.color.mode === "agent_runtime_default"
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
    desired: Map<string, RewriteValue | undefined>,
    current: Map<string, RewriteValue | undefined>,
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

function serializeFieldValue(value: RewriteValue): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    return JSON.stringify(value);
}

function splitDocument(text: string): { prefix: string; body: string } | null {
    const parsed = parseCursorFrontmatter(text);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    return { prefix: text.slice(0, text.length - parsed.body.length), body: parsed.body };
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function isSafeText(value: string): boolean {
    return value.trim() !== "" && !value.includes("\0") && !value.includes("\r");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
