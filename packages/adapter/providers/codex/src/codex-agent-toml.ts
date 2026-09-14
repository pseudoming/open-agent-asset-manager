/** Strict, non-executing Codex custom-agent TOML interpretation. */

import type { OperationDiagnostic } from "@oaam/core";
import { parse } from "smol-toml";
import { nonBlank, readDiagnostic } from "./codex-source-read-foundation";

const MAPPED_FIELDS = new Set([
    "name",
    "description",
    "developer_instructions",
    "nickname_candidates",
    "model",
    "model_reasoning_effort",
]);
const WHOLE_SOURCE_REJECTION_FIELDS = new Set(["hooks", "mcp_servers", "model_providers"]);

export interface ParsedCodexAgentToml {
    rejected: boolean;
    name: string | undefined;
    description: string | undefined;
    developerInstructions: string | undefined;
    model: string | undefined;
    effort: string | undefined;
    nicknameCandidates: string[];
    diagnostics: OperationDiagnostic[];
}

export function parseCodexAgentToml(content: string, path: string): ParsedCodexAgentToml {
    let value: unknown;
    try {
        value = parse(content);
    } catch {
        return invalidResult(path, "codex.subagent_toml_invalid", "Codex custom-agent TOML could not be parsed");
    }
    if (!isRecord(value)) {
        return invalidResult(path, "codex.subagent_toml_invalid", "Codex custom-agent TOML must contain a table");
    }

    const rejectedFields = Object.keys(value).filter((key) => WHOLE_SOURCE_REJECTION_FIELDS.has(key));
    if (rejectedFields.length > 0) {
        return {
            ...emptyResult(),
            rejected: true,
            diagnostics: [
                readDiagnostic(
                    "codex.subagent_executable_source_rejected",
                    `Codex custom agent contains executable, MCP, or remote-provider configuration: ${rejectedFields.join(", ")}`,
                    "unsupported",
                    "error",
                    path,
                ),
            ],
        };
    }

    const diagnostics: OperationDiagnostic[] = [];
    const name = requiredString(value, "name", diagnostics, path);
    const description = requiredString(value, "description", diagnostics, path);
    const developerInstructions = requiredString(value, "developer_instructions", diagnostics, path);
    const model = optionalString(value, "model", diagnostics, path);
    const effort = optionalString(value, "model_reasoning_effort", diagnostics, path);
    const nicknameCandidates = parseNicknames(value, diagnostics, path);

    const unsupported = Object.keys(value).filter((key) => !MAPPED_FIELDS.has(key));
    if (unsupported.length > 0) {
        diagnostics.push(
            readDiagnostic(
                "codex.subagent_configuration_semantics_unsupported",
                `Codex custom-agent fields have no exact Subagent V2 mapping: ${unsupported.join(", ")}`,
                "unsupported",
                "error",
                path,
            ),
        );
    }
    if (nicknameCandidates.length > 0) {
        diagnostics.push(
            readDiagnostic(
                "codex.subagent_nicknames_native_only",
                "Codex nickname candidates are preserved in the native representation but are not portable Subagent fields",
                "unsupported",
                "warning",
                path,
            ),
        );
    }

    return {
        rejected: false,
        name,
        description,
        developerInstructions,
        model,
        effort,
        nicknameCandidates,
        diagnostics,
    };
}

function requiredString(
    record: Record<string, unknown>,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string | undefined {
    if (record[key] === undefined) {
        diagnostics.push(
            readDiagnostic(
                "codex.subagent_required_field_missing",
                `Codex custom agent requires a non-empty ${key} string`,
                "invalid_schema",
                "error",
                path,
            ),
        );
        return undefined;
    }
    return optionalString(record, key, diagnostics, path);
}

function optionalString(
    record: Record<string, unknown>,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string | undefined {
    const raw = record[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || nonBlank(raw) === undefined) {
        diagnostics.push(
            readDiagnostic(
                "codex.subagent_field_invalid",
                `Codex custom-agent field ${key} must be a non-empty string`,
                "invalid_schema",
                "error",
                path,
            ),
        );
        return undefined;
    }
    return raw;
}

function parseNicknames(record: Record<string, unknown>, diagnostics: OperationDiagnostic[], path: string): string[] {
    const raw = record.nickname_candidates;
    if (raw === undefined) return [];
    if (
        !Array.isArray(raw) ||
        raw.length === 0 ||
        raw.some((item) => typeof item !== "string" || !isCodexNickname(item)) ||
        new Set(raw).size !== raw.length
    ) {
        diagnostics.push(
            readDiagnostic(
                "codex.subagent_nickname_candidates_invalid",
                "Codex nickname_candidates must be a unique non-empty list of ASCII names",
                "invalid_schema",
                "error",
                path,
            ),
        );
        return [];
    }
    return raw as string[];
}

function isCodexNickname(value: string): boolean {
    if (nonBlank(value) === undefined) return false;
    for (const character of value) {
        const code = character.charCodeAt(0);
        const accepted =
            (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            character === " " ||
            character === "-" ||
            character === "_";
        if (!accepted) return false;
    }
    return true;
}

function invalidResult(path: string, code: string, message: string): ParsedCodexAgentToml {
    return {
        ...emptyResult(),
        diagnostics: [readDiagnostic(code, message, "invalid_schema", "error", path)],
    };
}

function emptyResult(): ParsedCodexAgentToml {
    return {
        rejected: false,
        name: undefined,
        description: undefined,
        developerInstructions: undefined,
        model: undefined,
        effort: undefined,
        nicknameCandidates: [],
        diagnostics: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
