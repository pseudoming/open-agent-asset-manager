/** Lossless, fail-closed editing of the supported Codex custom-agent TOML subset. */

import type { AssetKindTypeDataV2, SubagentInstructionEntryV1 } from "@oaam/core";
import { stableSourceValueEqual } from "@oaam/adapter-framework";
import { parseCodexAgentToml } from "./codex-agent-toml";
import { CODEX_EFFORT_DIALECT, CODEX_MODEL_DIALECT } from "./codex-source-read-model";

type CodexSubagentCanonical = Extract<AssetKindTypeDataV2, { kind: "Subagent" }>;
type OwnedField = "name" | "description" | "developer_instructions" | "model" | "model_reasoning_effort";

interface OwnedAssignment {
    field: OwnedField;
    lineStart: number;
    lineEnd: number;
    valueStart: number;
    valueEnd: number;
    indentation: string;
    hasInlineComment: boolean;
}

export interface CodexSubagentCanonicalProjection {
    name: string;
    description: string;
    developerInstructions: string;
    model: string | undefined;
    effort: string | undefined;
}

interface TextEdit {
    start: number;
    end: number;
    replacement: string;
}

const REQUIRED_FIELDS: OwnedField[] = ["name", "description", "developer_instructions"];
const OPTIONAL_FIELDS: OwnedField[] = ["model", "model_reasoning_effort"];
const FIELD_PATTERN =
    /^(?<indent>[\t ]*)(?<field>name|description|developer_instructions|model|model_reasoning_effort)(?<separator>[\t ]*=[\t ]*)/u;
const SUPPORTED_BEHAVIORAL_ENVELOPE = {
    schemaVersion: 2,
    promptContextPolicy: { mode: "agent_runtime_default" },
    tools: {
        availability: { base: { mode: "inherit_available" }, unavailable: [] },
        permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
    },
    dependencies: { preloadedSkillVersionIds: [] },
    memory: { mode: "disabled" },
    execution: {
        permission: { mode: "inherit" },
        workspaceIsolation: { mode: "agent_runtime_default" },
        scheduling: { mode: "agent_runtime_default" },
        turnLimit: { mode: "agent_runtime_default" },
        sampling: {
            temperature: { mode: "agent_runtime_default" },
            topP: { mode: "agent_runtime_default" },
        },
    },
    directInvocation: { mode: "delegated_only" },
    presentation: {
        listing: "agent_runtime_default",
        color: { mode: "agent_runtime_default" },
    },
};

export function projectCodexSubagentCanonical(
    canonical: CodexSubagentCanonical,
    entryText: string,
): CodexSubagentCanonicalProjection | null {
    const instruction = parseInstructionEntry(entryText);
    const model = projectSelector(canonical.typeData.execution.model, CODEX_MODEL_DIALECT);
    const effort = projectSelector(canonical.typeData.execution.effort, CODEX_EFFORT_DIALECT);
    if (instruction === null || model === null || effort === null || !hasSupportedBehavioralEnvelope(canonical.typeData)) {
        return null;
    }
    return {
        name: canonical.typeData.name,
        description: canonical.typeData.description,
        developerInstructions: instruction,
        model,
        effort,
    };
}

function hasSupportedBehavioralEnvelope(typeData: CodexSubagentCanonical["typeData"]): boolean {
    const { name: _name, description: _description, execution, ...root } = typeData;
    const { model: _model, effort: _effort, ...executionEnvelope } = execution;
    return stableSourceValueEqual({ ...root, execution: executionEnvelope }, SUPPORTED_BEHAVIORAL_ENVELOPE);
}

export function rebaseCodexSubagentToml(parentText: string, target: CodexSubagentCanonicalProjection): string | null {
    const parsed = parseSupportedNative(parentText);
    if (parsed === null) return null;
    const desired: Record<OwnedField, string | undefined> = {
        name: target.name,
        description: target.description,
        developer_instructions: target.developerInstructions,
        model: target.model,
        model_reasoning_effort: target.effort,
    };
    const edits: TextEdit[] = [];
    for (const field of REQUIRED_FIELDS) {
        const assignment = parsed.assignments.get(field) as OwnedAssignment;
        edits.push(replaceValue(assignment, desired[field] as string));
    }
    for (const field of OPTIONAL_FIELDS) {
        const assignment = parsed.assignments.get(field);
        const value = desired[field];
        if (assignment !== undefined && value !== undefined) {
            edits.push(replaceValue(assignment, value));
        } else if (assignment !== undefined) {
            if (assignment.hasInlineComment) return null;
            edits.push({ start: assignment.lineStart, end: assignment.lineEnd, replacement: "" });
        }
    }
    const missing = OPTIONAL_FIELDS.filter((field) => desired[field] !== undefined && !parsed.assignments.has(field));
    if (missing.length > 0) {
        const anchor = parsed.assignments.get("developer_instructions") as OwnedAssignment;
        const lines = missing.map((field) => `${anchor.indentation}${field} = ${encodeBasicString(desired[field] as string)}`);
        const anchorEndsUnterminatedFile = anchor.lineEnd === parentText.length && !parentText.endsWith("\n");
        const inserted = anchorEndsUnterminatedFile ? `\n${lines.join("\n")}` : `${lines.join("\n")}\n`;
        edits.push({ start: anchor.lineEnd, end: anchor.lineEnd, replacement: inserted });
    }
    return applyEdits(parentText, edits);
}

export function reverseCodexSubagentInstruction(appliedText: string, currentText: string): string | null {
    const applied = parseSupportedNative(appliedText);
    const current = parseSupportedNative(currentText);
    const appliedDeveloper = applied?.assignments.get("developer_instructions");
    const currentDeveloper = current?.assignments.get("developer_instructions");
    if (applied === null || current === null || appliedDeveloper === undefined || currentDeveloper === undefined) return null;
    const restored = replaceRange(
        currentText,
        currentDeveloper.valueStart,
        currentDeveloper.valueEnd,
        appliedText.slice(appliedDeveloper.valueStart, appliedDeveloper.valueEnd),
    );
    if (restored !== appliedText || current.semantic.developerInstructions === undefined) return null;
    const entry: SubagentInstructionEntryV1 = {
        schemaVersion: 1,
        sections: [{ title: "", content: current.semantic.developerInstructions }],
    };
    return JSON.stringify(entry);
}

function parseInstructionEntry(text: string): string | null {
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

function projectSelector(
    selector: CodexSubagentCanonical["typeData"]["execution"]["model"],
    expectedDialectId: string,
): string | undefined | null {
    if (selector.mode === "inherit") return undefined;
    return selector.dialectId === expectedDialectId && selector.relativeTier === -1 && selector.selector.trim() !== ""
        ? selector.selector
        : null;
}

function parseSupportedNative(text: string): {
    assignments: Map<OwnedField, OwnedAssignment>;
    semantic: ReturnType<typeof parseCodexAgentToml>;
} | null {
    if (text.includes("\0") || text.includes("\r")) return null;
    const assignments = scanAssignments(text);
    if (assignments === null || REQUIRED_FIELDS.some((field) => !assignments.has(field))) return null;
    const semantic = parseCodexAgentToml(text, ".codex/agents/oaam-target.toml");
    if (
        semantic.rejected ||
        semantic.name === undefined ||
        semantic.description === undefined ||
        semantic.developerInstructions === undefined ||
        semantic.diagnostics.some((item) => item.severity === "error")
    ) {
        return null;
    }
    if ((semantic.model === undefined) !== !assignments.has("model")) return null;
    if ((semantic.effort === undefined) !== !assignments.has("model_reasoning_effort")) return null;
    return { assignments, semantic };
}

function scanAssignments(text: string): Map<OwnedField, OwnedAssignment> | null {
    const assignments = new Map<OwnedField, OwnedAssignment>();
    let lineStart = 0;
    while (lineStart < text.length) {
        const newline = text.indexOf("\n", lineStart);
        const contentEnd = newline === -1 ? text.length : newline;
        const lineEnd = newline === -1 ? text.length : newline + 1;
        const line = text.slice(lineStart, contentEnd);
        const match = FIELD_PATTERN.exec(line);
        if (match?.groups !== undefined) {
            const field = match.groups.field as OwnedField;
            if (assignments.has(field)) return null;
            const localValueStart = match[0].length;
            const localValueEnd = basicStringEnd(line, localValueStart);
            if (localValueEnd === null) return null;
            const suffix = line.slice(localValueEnd);
            const trimmedSuffix = suffix.trimStart();
            if (trimmedSuffix !== "" && !trimmedSuffix.startsWith("#")) return null;
            assignments.set(field, {
                field,
                lineStart,
                lineEnd,
                valueStart: lineStart + localValueStart,
                valueEnd: lineStart + localValueEnd,
                indentation: match.groups.indent,
                hasInlineComment: trimmedSuffix.startsWith("#"),
            });
        }
        if (newline === -1) break;
        lineStart = lineEnd;
    }
    return assignments;
}

function basicStringEnd(line: string, start: number): number | null {
    if (line[start] !== '"') return null;
    for (let index = start + 1; index < line.length; index += 1) {
        const character = line[index];
        if (character === "\\") {
            index += 1;
            if (index >= line.length) return null;
        } else if (character === '"') {
            return index + 1;
        }
    }
    return null;
}

function replaceValue(assignment: OwnedAssignment, value: string): TextEdit {
    return {
        start: assignment.valueStart,
        end: assignment.valueEnd,
        replacement: encodeBasicString(value),
    };
}

function encodeBasicString(value: string): string {
    return JSON.stringify(value);
}

function applyEdits(text: string, edits: TextEdit[]): string | null {
    const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
    let previousStart = text.length;
    let result = text;
    for (const edit of ordered) {
        if (edit.start < 0 || edit.end < edit.start || edit.end > previousStart) return null;
        result = replaceRange(result, edit.start, edit.end, edit.replacement);
        previousStart = edit.start;
    }
    return result;
}

function replaceRange(text: string, start: number, end: number, replacement: string): string {
    return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
