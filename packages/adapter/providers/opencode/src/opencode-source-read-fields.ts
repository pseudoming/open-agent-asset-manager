/** OpenCode frontmatter coercion and native selector semantics. */

import type { OperationDiagnostic, ToolSelectorV1 } from "@oaam/core";
import { projectBoundedFrontmatterDiagnostics, unknownSourceKeys as unknownKeys } from "@oaam/adapter-framework";
export { unknownKeys };
import {
    frontmatterBoolean,
    frontmatterMap,
    frontmatterNumber,
    frontmatterString,
    type ParsedOpencodeFrontmatter,
} from "./opencode-frontmatter";
import { isDigit, nonBlank, readDiagnostic } from "./opencode-source-read-foundation";
import { OPENCODE_COLOR_NAMES, TOOL_DIALECT } from "./opencode-source-read-model";

export function legacyToolPermissionSelector(selector: string): string {
    return selector === "write" || selector === "edit" || selector === "patch" ? "edit" : selector;
}

export function toolSelector(selector: string): ToolSelectorV1 {
    return { dialectId: TOOL_DIALECT, selector };
}

export function selectorTier(selector: string | undefined, dialectId: string) {
    const value = nonBlank(selector);
    return value === undefined
        ? { mode: "inherit" as const }
        : { mode: "selected" as const, dialectId, selector: value, relativeTier: -1 as const };
}

export function frontmatterDiagnostics(parsed: ParsedOpencodeFrontmatter, path: string): OperationDiagnostic[] {
    return projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "opencode.frontmatter_unclosed",
                "opencode declaration frontmatter is not closed",
                "invalid_schema",
                "error",
                path,
            ),
        (message) => readDiagnostic("opencode.frontmatter_unsupported", message, "invalid_schema", "error", path),
    );
}

export function optionalString(
    parsed: ParsedOpencodeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: string,
): string | undefined {
    const value = frontmatterString(parsed, key);
    if (parsed.presentKeys.includes(key) && value === undefined) {
        diagnostics.push(typeMismatchDiagnostic(kind, key, path));
    }
    return value;
}

export function optionalBoolean(
    parsed: ParsedOpencodeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: string,
): boolean | undefined {
    const value = frontmatterBoolean(parsed, key);
    if (parsed.presentKeys.includes(key) && value === undefined) {
        diagnostics.push(typeMismatchDiagnostic(kind, key, path));
    }
    return value;
}

export function optionalNumber(
    parsed: ParsedOpencodeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: string,
): number | undefined {
    const value = frontmatterNumber(parsed, key);
    if (parsed.presentKeys.includes(key) && value === undefined) {
        diagnostics.push(typeMismatchDiagnostic(kind, key, path));
    }
    return value;
}

export function stringMap(
    parsed: ParsedOpencodeFrontmatter,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
    kind: string,
): Record<string, string> {
    const value = frontmatterMap(parsed, key);
    if (value === undefined) {
        if (parsed.presentKeys.includes(key)) diagnostics.push(typeMismatchDiagnostic(kind, key, path));
        return {};
    }
    const result: Record<string, string> = {};
    for (const [mapKey, mapValue] of Object.entries(value)) {
        if (typeof mapValue !== "string") diagnostics.push(typeMismatchDiagnostic(kind, `${key}.${mapKey}`, path));
        else result[mapKey] = mapValue;
    }
    return result;
}

export function unknownFieldDiagnostic(kind: string, keys: string[], path: string): OperationDiagnostic {
    return readDiagnostic(
        "opencode.declaration_unknown_behavior",
        `${kind} contains unowned frontmatter fields: ${keys.join(", ")}`,
        "invalid_schema",
        "error",
        path,
    );
}

export function typeMismatchDiagnostic(kind: string, field: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "opencode.frontmatter_type_mismatch",
        `${kind} frontmatter field ${field} has an unsupported value type`,
        "invalid_schema",
        "error",
        path,
    );
}

export function positiveInt(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function isOpencodeColor(value: string): boolean {
    if (OPENCODE_COLOR_NAMES.has(value)) return true;
    if (value.length !== 7 || value[0] !== "#") return false;
    for (const character of value.slice(1)) {
        const lower = character.toLowerCase();
        if (!isDigit(character) && (lower < "a" || lower > "f")) return false;
    }
    return true;
}
