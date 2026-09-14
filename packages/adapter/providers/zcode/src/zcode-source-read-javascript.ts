/** Non-executing parser for the ZCode script Workflow `meta` literal. */

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

export interface ParsedZcodeScriptWorkflowMeta {
    name?: string;
    description?: string;
    issues: string[];
}

const DECLARATION = "export const meta";
const META_KEYS = new Set(["name", "description", "phases", "whenToUse"]);
const PHASE_KEYS = new Set(["title", "detail", "model"]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseZcodeScriptWorkflowMeta(text: string): ParsedZcodeScriptWorkflowMeta {
    const source = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
    const declaration = skipWhitespace(source, 0);
    if (!source.startsWith(DECLARATION, declaration)) {
        return { issues: ["script must begin with export const meta"] };
    }
    let cursor = skipWhitespace(source, declaration + DECLARATION.length);
    if (source[cursor] !== "=") return { issues: ["meta declaration requires ="] };
    cursor = skipWhitespace(source, cursor + 1);
    const parsed = parseLiteral(source, cursor);
    if (parsed === null || !isRecord(parsed.value)) return { issues: ["meta must be a pure object literal"] };
    cursor = skipWhitespaceAndComments(source, parsed.end);
    if (source[cursor] === ";") cursor = skipWhitespaceAndComments(source, cursor + 1);
    if (cursor > source.length) return { issues: ["meta declaration is malformed"] };

    const issues: string[] = [];
    const keys = Object.keys(parsed.value);
    const unknown = keys.filter((key) => !META_KEYS.has(key));
    if (unknown.length > 0) issues.push(`unknown meta fields: ${unknown.join(", ")}`);
    const name = nonBlankString(parsed.value.name);
    const description = nonBlankString(parsed.value.description);
    if (name === undefined) issues.push("meta.name must be a non-empty static string");
    if (description === undefined) issues.push("meta.description must be a non-empty static string");
    if (Object.hasOwn(parsed.value, "whenToUse") && nonBlankString(parsed.value.whenToUse) === undefined) {
        issues.push("meta.whenToUse must be a non-empty static string");
    }
    validatePhases(parsed.value.phases, issues);
    return { name, description, issues };
}

function validatePhases(value: Literal | undefined, issues: string[]): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
        issues.push("meta.phases must be a pure array literal");
        return;
    }
    const titles = new Set<string>();
    for (const [index, phase] of value.entries()) {
        if (!isRecord(phase)) {
            issues.push(`meta.phases[${index}] must be an object literal`);
            continue;
        }
        const unknown = Object.keys(phase).filter((key) => !PHASE_KEYS.has(key));
        if (unknown.length > 0) issues.push(`meta.phases[${index}] has unknown fields: ${unknown.join(", ")}`);
        const title = nonBlankString(phase.title);
        if (title === undefined) issues.push(`meta.phases[${index}].title must be a non-empty static string`);
        else if (titles.has(title)) issues.push(`meta.phases has duplicate title: ${title}`);
        else titles.add(title);
        for (const key of ["detail", "model"] as const) {
            if (Object.hasOwn(phase, key) && nonBlankString(phase[key]) === undefined) {
                issues.push(`meta.phases[${index}].${key} must be a non-empty static string`);
            }
        }
    }
}

function parseLiteral(text: string, start: number): { value: Literal; end: number } | null {
    const cursor = skipWhitespaceAndComments(text, start);
    const character = text[cursor];
    if (character === "{" || character === "[") return parseContainer(text, cursor, character);
    if (character === "'" || character === '"') return parseString(text, cursor, character);
    for (const [token, value] of [
        ["true", true],
        ["false", false],
        ["null", null],
    ] as const) {
        if (text.startsWith(token, cursor) && !isIdentifierCharacter(text[cursor + token.length] ?? "")) {
            return { value, end: cursor + token.length };
        }
    }
    return parseNumber(text, cursor);
}

function parseContainer(text: string, start: number, open: "{" | "["): { value: Literal; end: number } | null {
    const close = open === "{" ? "}" : "]";
    let cursor = skipWhitespaceAndComments(text, start + 1);
    if (open === "[") {
        const values: Literal[] = [];
        while (text[cursor] !== close) {
            const item = parseLiteral(text, cursor);
            if (item === null) return null;
            values.push(item.value);
            cursor = skipWhitespaceAndComments(text, item.end);
            if (text[cursor] === close) break;
            if (text[cursor] !== ",") return null;
            cursor = skipWhitespaceAndComments(text, cursor + 1);
            if (text[cursor] === close) break;
        }
        return text[cursor] === close ? { value: values, end: cursor + 1 } : null;
    }

    const value: Record<string, Literal> = Object.create(null) as Record<string, Literal>;
    while (text[cursor] !== close) {
        const key = parseObjectKey(text, cursor);
        if (key === null || UNSAFE_OBJECT_KEYS.has(key.value) || Object.hasOwn(value, key.value)) return null;
        cursor = skipWhitespaceAndComments(text, key.end);
        if (text[cursor] !== ":") return null;
        const item = parseLiteral(text, cursor + 1);
        if (item === null) return null;
        value[key.value] = item.value;
        cursor = skipWhitespaceAndComments(text, item.end);
        if (text[cursor] === close) break;
        if (text[cursor] !== ",") return null;
        cursor = skipWhitespaceAndComments(text, cursor + 1);
        if (text[cursor] === close) break;
    }
    return text[cursor] === close ? { value, end: cursor + 1 } : null;
}

function parseObjectKey(text: string, start: number): { value: string; end: number } | null {
    const cursor = skipWhitespaceAndComments(text, start);
    const character = text[cursor];
    if (character === "'" || character === '"') {
        const parsed = parseString(text, cursor, character);
        return parsed === null || typeof parsed.value !== "string" ? null : parsed;
    }
    let end = cursor;
    while (isIdentifierCharacter(text[end] ?? "")) end += 1;
    return end === cursor ? null : { value: text.slice(cursor, end), end };
}

function parseString(text: string, start: number, quote: "'" | '"'): { value: string; end: number } | null {
    let value = "";
    for (let cursor = start + 1; cursor < text.length; cursor += 1) {
        const character = text[cursor] ?? "";
        if (character === quote) return { value, end: cursor + 1 };
        if (character !== "\\") {
            value += character;
            continue;
        }
        const escaped = text[cursor + 1];
        if (escaped === undefined) return null;
        cursor += 1;
        const escapes: Record<string, string> = {
            "'": "'",
            '"': '"',
            "\\": "\\",
            n: "\n",
            r: "\r",
            t: "\t",
        };
        const projected = escapes[escaped];
        if (projected === undefined) return null;
        value += projected;
    }
    return null;
}

function parseNumber(text: string, start: number): { value: number; end: number } | null {
    let end = start;
    if (text[end] === "-") end += 1;
    let digits = 0;
    while (isDigit(text[end] ?? "")) {
        digits += 1;
        end += 1;
    }
    if (text[end] === ".") {
        end += 1;
        while (isDigit(text[end] ?? "")) {
            digits += 1;
            end += 1;
        }
    }
    if (digits === 0 || isIdentifierCharacter(text[end] ?? "")) return null;
    const value = Number(text.slice(start, end));
    return Number.isFinite(value) ? { value, end } : null;
}

function skipWhitespace(text: string, start: number): number {
    let cursor = start;
    while (isWhitespace(text[cursor] ?? "")) cursor += 1;
    return cursor;
}

function skipWhitespaceAndComments(text: string, start: number): number {
    let cursor = skipWhitespace(text, start);
    while (text[cursor] === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*")) {
        if (text[cursor + 1] === "/") {
            const lineEnd = text.indexOf("\n", cursor + 2);
            cursor = lineEnd < 0 ? text.length : lineEnd + 1;
        } else {
            const blockEnd = text.indexOf("*/", cursor + 2);
            if (blockEnd < 0) return text.length + 1;
            cursor = blockEnd + 2;
        }
        cursor = skipWhitespace(text, cursor);
    }
    return cursor;
}

function nonBlankString(value: Literal | undefined): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: Literal): value is { [key: string]: Literal } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifierCharacter(value: string): boolean {
    return value === "_" || value === "$" || isDigit(value) || isAsciiLetter(value);
}

function isDigit(value: string): boolean {
    return value >= "0" && value <= "9";
}

function isAsciiLetter(value: string): boolean {
    return (value >= "a" && value <= "z") || (value >= "A" && value <= "Z");
}

function isWhitespace(value: string): boolean {
    return value === " " || value === "\t" || value === "\n" || value === "\r";
}
