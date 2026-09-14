/** Current Antigravity Markdown Subagent semantics and lossless native editing. */

import type { AssetKindTypeDataV2, OperationDiagnostic, SubagentInstructionEntryV1, SubagentTypeDataV2 } from "@oaam/core";
import { stableSourceValueEqual } from "@oaam/adapter-framework";
import {
    antigravityFrontmatterBoolean,
    antigravityFrontmatterString,
    antigravityFrontmatterStrings,
    parseAntigravityFrontmatter,
    type ParsedAntigravityFrontmatter,
} from "./antigravity-frontmatter";
import {
    frontmatterDiagnostics,
    nonBlank,
    readDiagnostic,
    uniquePreservingOrder,
    unknownFieldDiagnostic,
    unknownKeys,
} from "./antigravity-source-read-foundation";

type SubagentCanonical = Extract<AssetKindTypeDataV2, { kind: "Subagent" }>;

export const ANTIGRAVITY_SUBAGENT_TOOL_DIALECT = "antigravity-tool-name-v1";
export const ANTIGRAVITY_SUBAGENT_MODEL_DIALECT = "antigravity-subagent-model-v1";
export const ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT = "antigravity-command-execution-policy-v1";

const SUPPORTED_KEYS = [
    "commandExecutionPolicy",
    "description",
    "hidden",
    "inheritMcp",
    "mainAgent",
    "mcpServers",
    "model",
    "name",
    "plugins",
    "skills",
    "subagent",
    "tools",
] as const;

const PERMISSION_EFFECTS = {
    off: "interactive",
    auto: "classifier_mediated",
    eager: "auto_approve_selected_operations",
    sandbox: "auto_approve_selected_operations",
} as const satisfies Record<string, Exclude<SubagentTypeDataV2["execution"]["permission"], { mode: "inherit" }>["effect"]>;

const MODEL_TIERS = {
    flash: 1,
    pro: 10,
} as const;

export type ParsedAntigravityMarkdownSubagent =
    | {
          disposition: "candidate";
          name: string;
          description: string;
          body: string;
          instruction: SubagentInstructionEntryV1;
          typeData: SubagentTypeDataV2;
          diagnostics: OperationDiagnostic[];
      }
    | {
          disposition: "ignored";
          excludedSource: boolean;
          diagnostics: OperationDiagnostic[];
      };

export interface AntigravityMarkdownSubagentProjection {
    name: string;
    description: string;
    body: string;
    tools: string[] | undefined;
    mainAgent: boolean | undefined;
    model: "flash" | "pro" | undefined;
    commandExecutionPolicy: keyof typeof PERMISSION_EFFECTS | undefined;
    hidden: boolean | undefined;
}

type FrontmatterRewriteValue = boolean | string | readonly string[];

export function parseAntigravityMarkdownSubagent(text: string, relativePath: string): ParsedAntigravityMarkdownSubagent {
    const parsed = parseAntigravityFrontmatter(text);
    const diagnostics = frontmatterDiagnostics(parsed, relativePath);
    if (!parsed.hasFrontmatter || !parsed.closed) {
        return ignored(
            false,
            diagnostics,
            readDiagnostic(
                "antigravity.subagent_markdown_frontmatter_missing",
                "Markdown Subagent requires closed YAML frontmatter",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }

    const name = nonBlank(antigravityFrontmatterString(parsed, "name"));
    const description = nonBlank(antigravityFrontmatterString(parsed, "description"));
    if (name === undefined || description === undefined || parsed.body.trim() === "") {
        return ignored(
            false,
            diagnostics,
            readDiagnostic(
                "antigravity.subagent_markdown_required_content_missing",
                "Markdown Subagent requires non-empty name, description, and instruction body",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }

    const mcpServers = parsed.values.mcpServers;
    const plugins = stringList(parsed, "plugins", diagnostics, relativePath);
    const inheritMcp = booleanField(parsed, "inheritMcp", diagnostics, relativePath);
    if (
        (parsed.presentKeys.includes("mcpServers") && (!Array.isArray(mcpServers) || mcpServers.length > 0)) ||
        (plugins !== undefined && plugins.length > 0) ||
        inheritMcp === true
    ) {
        return ignored(
            true,
            diagnostics,
            readDiagnostic(
                "antigravity.subagent_markdown_excluded_dependency",
                "Markdown Subagent contains MCP or plugin-owned behavior excluded from OAAM v1",
                "unsupported",
                "error",
                relativePath,
            ),
        );
    }

    const subagent = booleanField(parsed, "subagent", diagnostics, relativePath);
    if (subagent === false) {
        return ignored(
            true,
            diagnostics,
            readDiagnostic(
                "antigravity.subagent_markdown_not_delegation_capable",
                "This custom agent disables subagent invocation and is not an OAAM Subagent asset",
                "unsupported",
                "warning",
                relativePath,
            ),
        );
    }

    const unknown = unknownKeys(parsed, [...SUPPORTED_KEYS]);
    if (unknown.length > 0) diagnostics.push(unknownFieldDiagnostic("Subagent", unknown, relativePath));
    const skills = stringList(parsed, "skills", diagnostics, relativePath);
    if (skills !== undefined && skills.length > 0) {
        diagnostics.push(
            readDiagnostic(
                "antigravity.subagent_skill_binding_pending",
                "Subagent Skill dependencies require accepted immutable Skill Version bindings before import",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }

    const tools = stringList(parsed, "tools", diagnostics, relativePath);
    const mainAgent = booleanField(parsed, "mainAgent", diagnostics, relativePath);
    const hidden = booleanField(parsed, "hidden", diagnostics, relativePath);
    const model = stringField(parsed, "model", diagnostics, relativePath);
    const commandExecutionPolicy = stringField(parsed, "commandExecutionPolicy", diagnostics, relativePath);
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
                                    selector: { dialectId: ANTIGRAVITY_SUBAGENT_TOOL_DIALECT, selector },
                                })),
                            },
                unavailable: [],
            },
            permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
        },
        dependencies: { preloadedSkillVersionIds: [] },
        memory: { mode: "disabled" },
        execution: {
            permission: permissionPolicy(commandExecutionPolicy, diagnostics, relativePath),
            workspaceIsolation: { mode: "agent_runtime_default" },
            scheduling: { mode: "agent_runtime_default" },
            turnLimit: { mode: "agent_runtime_default" },
            model: modelPolicy(model, diagnostics, relativePath),
            effort: { mode: "inherit" },
            sampling: {
                temperature: { mode: "agent_runtime_default" },
                topP: { mode: "agent_runtime_default" },
            },
        },
        directInvocation:
            mainAgent === undefined
                ? { mode: "agent_runtime_default" }
                : mainAgent
                  ? { mode: "user_selectable", initialPrompt: { mode: "none" } }
                  : { mode: "delegated_only" },
        presentation: {
            listing: hidden === undefined ? "agent_runtime_default" : hidden ? "hidden" : "visible",
            color: { mode: "agent_runtime_default" },
        },
    };
    return {
        disposition: "candidate",
        name,
        description,
        body: parsed.body,
        instruction: { schemaVersion: 1, sections: [{ title: "", content: parsed.body }] },
        typeData,
        diagnostics,
    };
}

export function projectAntigravityMarkdownSubagentCanonical(
    canonical: SubagentCanonical,
    entryText: string,
): AntigravityMarkdownSubagentProjection | null {
    const body = parseInstructionBody(entryText);
    const tools = projectTools(canonical.typeData);
    const mainAgent = projectDirectInvocation(canonical.typeData);
    const model = projectModel(canonical.typeData);
    const commandExecutionPolicy = projectPermission(canonical.typeData);
    const hidden = projectListing(canonical.typeData);
    if (
        body === null ||
        tools === null ||
        mainAgent === null ||
        model === null ||
        commandExecutionPolicy === null ||
        hidden === null ||
        !hasSupportedEnvelope(canonical.typeData)
    ) {
        return null;
    }
    return {
        name: canonical.typeData.name,
        description: canonical.typeData.description,
        body,
        tools,
        mainAgent,
        model,
        commandExecutionPolicy,
        hidden,
    };
}

export function serializeAntigravityMarkdownSubagent(projection: AntigravityMarkdownSubagentProjection): string {
    const lines = [
        "---",
        `name: ${JSON.stringify(projection.name)}`,
        `description: ${JSON.stringify(projection.description)}`,
        "subagent: true",
    ];
    if (projection.tools !== undefined) lines.push(`tools: ${JSON.stringify(projection.tools)}`);
    if (projection.mainAgent !== undefined) lines.push(`mainAgent: ${projection.mainAgent ? "true" : "false"}`);
    if (projection.model !== undefined) lines.push(`model: ${projection.model}`);
    if (projection.commandExecutionPolicy !== undefined) {
        lines.push(`commandExecutionPolicy: ${projection.commandExecutionPolicy}`);
    }
    if (projection.hidden !== undefined) lines.push(`hidden: ${projection.hidden ? "true" : "false"}`);
    return `${lines.join("\n")}\n---\n${projection.body}`;
}

export function rebaseAntigravityMarkdownSubagent(
    parentText: string,
    projection: AntigravityMarkdownSubagentProjection,
): string | null {
    const parent = parseAntigravityMarkdownSubagent(parentText, "agents/parent.md");
    if (parent.disposition !== "candidate" || parent.diagnostics.some((item) => item.severity === "error")) return null;
    const parentProjection = projectAntigravityMarkdownSubagentCanonical(
        { kind: "Subagent", typeData: parent.typeData },
        JSON.stringify(parent.instruction),
    );
    if (parentProjection === null) return null;
    const desired = new Map<string, FrontmatterRewriteValue | undefined>([
        ["name", projection.name],
        ["description", projection.description],
        ["tools", projection.tools],
        ["mainAgent", projection.mainAgent],
        ["model", projection.model],
        ["commandExecutionPolicy", projection.commandExecutionPolicy],
        ["hidden", projection.hidden],
    ]);
    const current = new Map<string, FrontmatterRewriteValue | undefined>([
        ["name", parentProjection.name],
        ["description", parentProjection.description],
        ["tools", parentProjection.tools],
        ["mainAgent", parentProjection.mainAgent],
        ["model", parentProjection.model],
        ["commandExecutionPolicy", parentProjection.commandExecutionPolicy],
        ["hidden", parentProjection.hidden],
    ]);
    const rewrittenPrefix = rewriteFrontmatter(parentText, desired, current);
    if (rewrittenPrefix === null) return null;
    return `${rewrittenPrefix}${projection.body}`;
}

export function reverseAntigravityMarkdownSubagent(appliedText: string, currentText: string): string | null {
    const applied = splitDocument(appliedText);
    const current = splitDocument(currentText);
    if (applied === null || current === null || applied.prefix !== current.prefix) return null;
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: current.body }] });
}

function permissionPolicy(
    selector: string | undefined,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["execution"]["permission"] {
    if (selector === undefined) return { mode: "inherit" };
    const effect = PERMISSION_EFFECTS[selector as keyof typeof PERMISSION_EFFECTS];
    if (effect === undefined) {
        diagnostics.push(invalidSelector("commandExecutionPolicy", path));
        return { mode: "inherit" };
    }
    return { mode: "selected", dialectId: ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT, selector, effect };
}

function modelPolicy(
    selector: string | undefined,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentTypeDataV2["execution"]["model"] {
    if (selector === undefined || selector === "inherit") return { mode: "inherit" };
    const relativeTier = MODEL_TIERS[selector as keyof typeof MODEL_TIERS];
    if (relativeTier === undefined) {
        diagnostics.push(invalidSelector("model", path));
        return { mode: "inherit" };
    }
    return { mode: "selected", dialectId: ANTIGRAVITY_SUBAGENT_MODEL_DIALECT, selector, relativeTier };
}

function projectTools(typeData: SubagentTypeDataV2): string[] | undefined | null {
    if (typeData.tools.availability.unavailable.length !== 0) return null;
    if (typeData.tools.permission.rules.length !== 0 || typeData.tools.permission.otherwise !== "inherit_agent_runtime_policy") {
        return null;
    }
    const base = typeData.tools.availability.base;
    if (base.mode === "inherit_available") return undefined;
    if (base.mode === "none") return [];
    const projected: string[] = [];
    for (const item of base.allowed) {
        if (item.mode !== "agent_runtime_tool" || item.selector.dialectId !== ANTIGRAVITY_SUBAGENT_TOOL_DIALECT) {
            return null;
        }
        projected.push(item.selector.selector);
    }
    return uniquePreservingOrder(projected);
}

function projectDirectInvocation(typeData: SubagentTypeDataV2): boolean | undefined | null {
    if (typeData.directInvocation.mode === "agent_runtime_default") return undefined;
    if (typeData.directInvocation.mode === "delegated_only") return false;
    return typeData.directInvocation.initialPrompt.mode === "none" ? true : null;
}

function projectModel(typeData: SubagentTypeDataV2): "flash" | "pro" | undefined | null {
    const model = typeData.execution.model;
    if (model.mode === "inherit") return undefined;
    if (model.dialectId !== ANTIGRAVITY_SUBAGENT_MODEL_DIALECT) return null;
    const tier = MODEL_TIERS[model.selector as keyof typeof MODEL_TIERS];
    return tier === model.relativeTier ? (model.selector as "flash" | "pro") : null;
}

function projectPermission(typeData: SubagentTypeDataV2): keyof typeof PERMISSION_EFFECTS | undefined | null {
    const permission = typeData.execution.permission;
    if (permission.mode === "inherit") return undefined;
    if (permission.dialectId !== ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT) return null;
    const effect = PERMISSION_EFFECTS[permission.selector as keyof typeof PERMISSION_EFFECTS];
    return effect === permission.effect ? (permission.selector as keyof typeof PERMISSION_EFFECTS) : null;
}

function projectListing(typeData: SubagentTypeDataV2): boolean | undefined | null {
    if (typeData.presentation.color.mode !== "agent_runtime_default") return null;
    if (typeData.presentation.listing === "agent_runtime_default") return undefined;
    return typeData.presentation.listing === "hidden";
}

function hasSupportedEnvelope(typeData: SubagentTypeDataV2): boolean {
    return (
        stableSourceValueEqual(typeData.promptContextPolicy, { mode: "agent_runtime_default" }) &&
        typeData.dependencies.preloadedSkillVersionIds.length === 0 &&
        stableSourceValueEqual(typeData.memory, { mode: "disabled" }) &&
        stableSourceValueEqual(typeData.execution.workspaceIsolation, { mode: "agent_runtime_default" }) &&
        stableSourceValueEqual(typeData.execution.scheduling, { mode: "agent_runtime_default" }) &&
        stableSourceValueEqual(typeData.execution.turnLimit, { mode: "agent_runtime_default" }) &&
        stableSourceValueEqual(typeData.execution.effort, { mode: "inherit" }) &&
        stableSourceValueEqual(typeData.execution.sampling, {
            temperature: { mode: "agent_runtime_default" },
            topP: { mode: "agent_runtime_default" },
        })
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
    if (!isRecord(section) || Object.keys(section).sort().join("\0") !== "content\0title") return null;
    return section.title === "" && typeof section.content === "string" && section.content.trim() !== "" ? section.content : null;
}

function booleanField(
    parsed: ParsedAntigravityFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): boolean | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = antigravityFrontmatterBoolean(parsed, key);
    if (value === undefined) diagnostics.push(invalidField(key, path));
    return value;
}

function stringField(
    parsed: ParsedAntigravityFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = nonBlank(antigravityFrontmatterString(parsed, key));
    if (value === undefined) diagnostics.push(invalidField(key, path));
    return value;
}

function stringList(
    parsed: ParsedAntigravityFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string[] | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const values = antigravityFrontmatterStrings(parsed, key);
    if (values === undefined || values.some((value) => value.trim() === "")) {
        diagnostics.push(invalidField(key, path));
        return [];
    }
    return uniquePreservingOrder(values.map((value) => value.trim()));
}

function ignored(
    excludedSource: boolean,
    diagnostics: OperationDiagnostic[],
    issue: OperationDiagnostic,
): ParsedAntigravityMarkdownSubagent {
    return { disposition: "ignored", excludedSource, diagnostics: [...diagnostics, issue] };
}

function invalidField(field: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "antigravity.subagent_markdown_field_invalid",
        `Markdown Subagent field ${field} has an invalid type or value`,
        "invalid_schema",
        "error",
        path,
    );
}

function invalidSelector(field: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "antigravity.subagent_markdown_selector_invalid",
        `Markdown Subagent field ${field} uses an unsupported selector`,
        "invalid_schema",
        "error",
        path,
    );
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
        const currentValue = current.get(key);
        if (stableSourceValueEqual(desiredValue, currentValue)) continue;
        const field = scanned.fields.get(key);
        if (field === undefined) {
            if (desiredValue !== undefined) {
                edits.push({
                    start: scanned.closingStart,
                    end: scanned.closingStart,
                    replacement: `${key}: ${serializeFieldValue(desiredValue)}\n`,
                });
            }
            continue;
        }
        if (desiredValue === undefined) {
            if (field.containsComment) return null;
            edits.push({ start: field.start, end: field.end, replacement: "" });
        } else if (field.multiline) {
            if (field.containsComment) return null;
            edits.push({ start: field.start, end: field.end, replacement: `${key}: ${serializeFieldValue(desiredValue)}\n` });
        } else {
            edits.push({
                start: field.valueStart,
                end: field.valueEnd,
                replacement: serializeFieldValue(desiredValue),
            });
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
        if (escaped) {
            escaped = false;
        } else if (quote !== null) {
            if (character === "\\" && quote === '"') escaped = true;
            else if (character === quote) quote = null;
        } else if (character === "'" || character === '"') {
            quote = character;
        } else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] as string))) {
            return index;
        }
    }
    return -1;
}

function serializeFieldValue(value: FrontmatterRewriteValue): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    return JSON.stringify(value);
}

function splitDocument(text: string): { prefix: string; body: string } | null {
    const parsed = parseAntigravityFrontmatter(text);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    return { prefix: text.slice(0, text.length - parsed.body.length), body: parsed.body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
