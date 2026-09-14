/** Configurable, bounded, non-executing Markdown frontmatter syntax engine. */

import { compareCodeUnitText, isAsciiWhitespace } from "./source-text";

export type BoundedFrontmatterScalar = string | number | boolean | null;
export type BoundedFrontmatterValue =
    | BoundedFrontmatterScalar
    | BoundedFrontmatterScalar[]
    | Record<string, BoundedFrontmatterScalar>;

export interface ParsedBoundedFrontmatter {
    hasFrontmatter: boolean;
    closed: boolean;
    values: Record<string, BoundedFrontmatterValue>;
    presentKeys: string[];
    body: string;
    diagnostics: string[];
}

export interface BoundedFrontmatterSyntax {
    mappingKeys: "plain" | "quoted_scalar";
    nestedMapValues: "string" | "non_null_scalar";
    inlineListNesting: "balanced" | "flat";
}

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseBoundedFrontmatter(content: string, syntax: BoundedFrontmatterSyntax): ParsedBoundedFrontmatter {
    const lines = splitLinesWithOffsets(content);
    if (lines[0]?.text !== "---") return emptyFrontmatter(content);
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.text === "---");
    if (closingIndex === -1) {
        return {
            hasFrontmatter: true,
            closed: false,
            values: {},
            presentKeys: [],
            body: content,
            diagnostics: ["frontmatter is not closed"],
        };
    }

    const values: Record<string, BoundedFrontmatterValue> = {};
    const presentKeys: string[] = [];
    const diagnostics: string[] = [];
    let activeContainer: { key: string; kind: "unknown" | "list" | "record" } | null = null;

    for (let index = 1; index < closingIndex; index += 1) {
        const rawLine = lines[index].text;
        if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
        const indentation = countLeadingSpaces(rawLine);
        if (rawLine[indentation] === "\t") {
            diagnostics.push(`unsupported tab indentation on frontmatter line ${index + 1}`);
            activeContainer = null;
            continue;
        }
        if (indentation === 0) {
            const pair = splitKeyValue(rawLine, syntax);
            if (pair === null) {
                diagnostics.push(`unsupported frontmatter line ${index + 1}`);
                activeContainer = null;
                continue;
            }
            const [key, rawValue] = pair;
            if (UNSAFE_OBJECT_KEYS.has(key)) {
                diagnostics.push(`unsafe frontmatter key ${key}`);
                activeContainer = null;
                continue;
            }
            if (Object.hasOwn(values, key)) {
                diagnostics.push(`duplicate frontmatter key ${key}`);
                activeContainer = null;
                continue;
            }
            presentKeys.push(key);
            if (rawValue === "") {
                values[key] = null;
                activeContainer = { key, kind: "unknown" };
                continue;
            }
            const parsed = parseInlineValue(rawValue, syntax);
            if (parsed === undefined) {
                diagnostics.push(`unsupported value for frontmatter key ${key}`);
                values[key] = rawValue;
            } else {
                values[key] = parsed;
            }
            activeContainer = null;
            continue;
        }

        if (activeContainer === null) {
            diagnostics.push(`orphan nested frontmatter line ${index + 1}`);
            continue;
        }
        const nested = rawLine.trim();
        if (nested.startsWith("-")) {
            if (nested.length === 1 || nested[1] !== " ") {
                diagnostics.push(`invalid list item for ${activeContainer.key}`);
                continue;
            }
            if (activeContainer.kind === "record") {
                diagnostics.push(`mixed list/map value for ${activeContainer.key}`);
                continue;
            }
            if (activeContainer.kind === "unknown") {
                activeContainer.kind = "list";
                values[activeContainer.key] = [];
            }
            const parsed = parseScalar(nested.slice(2).trim());
            if (parsed === undefined) {
                diagnostics.push(`unsupported list item for ${activeContainer.key}`);
                continue;
            }
            (values[activeContainer.key] as BoundedFrontmatterScalar[]).push(parsed);
            continue;
        }

        const pair = splitKeyValue(nested, syntax);
        if (pair === null || pair[0] === "") {
            diagnostics.push(`unsupported nested value for ${activeContainer.key}`);
            continue;
        }
        if (activeContainer.kind === "list") {
            diagnostics.push(`mixed list/map value for ${activeContainer.key}`);
            continue;
        }
        if (activeContainer.kind === "unknown") {
            activeContainer.kind = "record";
            values[activeContainer.key] = {};
        }
        if (UNSAFE_OBJECT_KEYS.has(pair[0])) {
            diagnostics.push(`unsafe map key ${activeContainer.key}.${pair[0]}`);
            continue;
        }
        const parsed = parseScalar(pair[1]);
        if (!acceptedMapValue(parsed, syntax)) {
            const description = syntax.nestedMapValues === "string" ? "non-string" : "unsupported";
            diagnostics.push(`${description} map value for ${activeContainer.key}.${pair[0]}`);
            continue;
        }
        const record = values[activeContainer.key] as Record<string, BoundedFrontmatterScalar>;
        if (Object.hasOwn(record, pair[0])) {
            diagnostics.push(`duplicate map key ${activeContainer.key}.${pair[0]}`);
        } else {
            record[pair[0]] = parsed;
        }
    }

    return {
        hasFrontmatter: true,
        closed: true,
        values,
        presentKeys: presentKeys.sort(compareCodeUnitText),
        body: content.slice(lines[closingIndex].endOffset),
        diagnostics,
    };
}

export function projectBoundedFrontmatterDiagnostics<T>(
    parsed: Pick<ParsedBoundedFrontmatter, "hasFrontmatter" | "closed" | "diagnostics">,
    projectUnclosed: () => T,
    projectParserDiagnostic: (message: string) => T,
): T[] {
    const projected: T[] = [];
    if (parsed.hasFrontmatter && !parsed.closed) projected.push(projectUnclosed());
    for (const message of parsed.diagnostics) {
        projected.push(projectParserDiagnostic(message));
    }
    return projected;
}

export function splitBoundedDelimited(value: string, balanced: boolean): string[] {
    return splitDelimitedTokens(value, balanced).map(unquote);
}

export function boundedFrontmatterString(parsed: ParsedBoundedFrontmatter, key: string): string | undefined {
    const value = parsed.values[key];
    return typeof value === "string" ? value : undefined;
}

export function boundedFrontmatterBoolean(parsed: ParsedBoundedFrontmatter, key: string): boolean | undefined {
    const value = parsed.values[key];
    return typeof value === "boolean" ? value : undefined;
}

export function boundedFrontmatterFiniteNumber(parsed: ParsedBoundedFrontmatter, key: string): number | undefined {
    const value = parsed.values[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function boundedFrontmatterStringList(
    parsed: ParsedBoundedFrontmatter,
    key: string,
    balanced = true,
): string[] | undefined {
    const value = parsed.values[key];
    if (typeof value === "string") return splitBoundedDelimited(value, balanced);
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
    return value.map((item) => String(item).trim()).filter((item) => item !== "");
}

export function boundedFrontmatterStringMap(parsed: ParsedBoundedFrontmatter, key: string): Record<string, string> | undefined {
    const value = parsed.values[key];
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.values(value).some((item) => typeof item !== "string")
    ) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, String(item)]));
}

export function boundedFrontmatterScalarMap(
    parsed: ParsedBoundedFrontmatter,
    key: string,
): Record<string, BoundedFrontmatterScalar> | undefined {
    const value = parsed.values[key];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
}

function emptyFrontmatter(content: string): ParsedBoundedFrontmatter {
    return {
        hasFrontmatter: false,
        closed: false,
        values: {},
        presentKeys: [],
        body: content,
        diagnostics: [],
    };
}

function parseInlineValue(rawValue: string, syntax: BoundedFrontmatterSyntax): BoundedFrontmatterValue | undefined {
    const trimmed = stripTrailingComment(rawValue.trim());
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const values: BoundedFrontmatterScalar[] = [];
        for (const token of splitDelimitedTokens(trimmed.slice(1, -1), syntax.inlineListNesting === "balanced")) {
            const parsed = parseScalar(token);
            if (parsed === undefined) return undefined;
            values.push(parsed);
        }
        return values;
    }
    if (trimmed === "{}") return {};
    return parseScalar(trimmed);
}

function parseScalar(rawValue: string): BoundedFrontmatterScalar | undefined {
    const trimmed = stripTrailingComment(rawValue.trim());
    if (trimmed === "") return "";
    if (trimmed === "null" || trimmed === "~") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && String(numeric) === trimmed) return numeric;
    if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
        if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return undefined;
        try {
            return JSON.parse(trimmed) as string;
        } catch {
            return undefined;
        }
    }
    if (trimmed.startsWith("'") || trimmed.endsWith("'")) {
        if (!(trimmed.startsWith("'") && trimmed.endsWith("'"))) return undefined;
        return trimmed.slice(1, -1).split("''").join("'");
    }
    if (trimmed.startsWith("|") || trimmed.startsWith(">") || trimmed.startsWith("{")) {
        return undefined;
    }
    return trimmed;
}

function splitDelimitedTokens(value: string, balanced: boolean): string[] {
    const result: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;
    let depth = 0;
    for (const character of value) {
        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }
        if (character === "\\" && quote !== null) {
            current += character;
            escaped = true;
            continue;
        }
        if (quote !== null) {
            current += character;
            if (character === quote) quote = null;
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            current += character;
            continue;
        }
        if (balanced && (character === "(" || character === "[")) depth += 1;
        if (balanced && (character === ")" || character === "]") && depth > 0) depth -= 1;
        if (character === "," && depth === 0) {
            const item = current.trim();
            if (item !== "") result.push(item);
            current = "";
        } else {
            current += character;
        }
    }
    const item = current.trim();
    if (item !== "") result.push(item);
    return result;
}

function unquote(value: string): string {
    if (value.length < 2) return value;
    const quote = value[0];
    if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) return value;
    const inner = value.slice(1, -1);
    if (quote === "'") return inner.split("''").join("'");
    try {
        return JSON.parse(value) as string;
    } catch {
        return inner;
    }
}

function stripTrailingComment(value: string): string {
    let quote: "'" | '"' | null = null;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote !== null) {
            if (character === quote && value[index - 1] !== "\\") quote = null;
            continue;
        }
        if (character === "'" || character === '"') quote = character;
        else if (character === "#" && (index === 0 || isAsciiWhitespace(value[index - 1]))) {
            return value.slice(0, index).trimEnd();
        }
    }
    return value;
}

function splitKeyValue(line: string, syntax: BoundedFrontmatterSyntax): [string, string] | null {
    const separator = line.indexOf(":");
    if (separator <= 0) return null;
    const rawKey = line.slice(0, separator);
    const key = syntax.mappingKeys === "quoted_scalar" ? parseMappingKey(rawKey) : rawKey.trim();
    return key === null ? null : [key, line.slice(separator + 1).trim()];
}

function parseMappingKey(rawKey: string): string | null {
    const key = rawKey.trim();
    if (key === "") return null;
    if (key.startsWith('"') || key.endsWith('"') || key.startsWith("'") || key.endsWith("'")) {
        const parsed = parseScalar(key);
        return typeof parsed === "string" && parsed !== "" ? parsed : null;
    }
    return key;
}

function acceptedMapValue(
    value: BoundedFrontmatterScalar | undefined,
    syntax: BoundedFrontmatterSyntax,
): value is BoundedFrontmatterScalar {
    return syntax.nestedMapValues === "string" ? typeof value === "string" : value !== undefined && value !== null;
}

function countLeadingSpaces(line: string): number {
    let count = 0;
    while (line[count] === " ") count += 1;
    return count;
}

function splitLinesWithOffsets(content: string): Array<{ text: string; endOffset: number }> {
    const lines: Array<{ text: string; endOffset: number }> = [];
    let start = 0;
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] !== "\n") continue;
        const raw = content.slice(start, index);
        lines.push({
            text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
            endOffset: index + 1,
        });
        start = index + 1;
    }
    const raw = content.slice(start);
    lines.push({
        text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
        endOffset: content.length,
    });
    return lines;
}
