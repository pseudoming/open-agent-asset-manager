/** Non-executing parser for Claude Code JavaScript Workflow metadata. */

import { isAsciiWhitespace } from "@oaam/adapter-framework";

export function parseJavaScriptWorkflowMeta(text: string): { name?: string; description?: string } {
    const declaration = findExactMetaDeclaration(text);
    if (declaration === -1) return {};
    const afterDeclaration = text.slice(declaration + "export const meta".length).trimStart();
    if (!afterDeclaration.startsWith("=")) return {};
    const objectExpression = afterDeclaration.slice(1).trimStart();
    if (!objectExpression.startsWith("{")) return {};
    const open = text.length - objectExpression.length;
    const close = findMatchingBrace(text, open);
    if (close === -1) return {};
    const objectText = text.slice(open + 1, close);
    return {
        name: readStaticObjectString(objectText, "name"),
        description: readStaticObjectString(objectText, "description"),
    };
}

function findExactMetaDeclaration(text: string): number {
    const marker = "export const meta";
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let previousCodeCharacter = "";
    for (let cursor = 0; cursor < text.length; cursor += 1) {
        const character = text[cursor] ?? "";
        const next = text[cursor + 1] ?? "";
        if (lineComment) {
            if (character === "\n" || character === "\r") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === "*" && next === "/") {
                blockComment = false;
                cursor += 1;
            }
            continue;
        }
        if (quote !== null) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "/" && next === "/") {
            lineComment = true;
            cursor += 1;
            continue;
        }
        if (character === "/" && next === "*") {
            blockComment = true;
            cursor += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === "`") {
            quote = character;
            continue;
        }
        if (text.startsWith(marker, cursor)) {
            const after = text[cursor + marker.length] ?? "";
            if (
                !isIdentifierCharacter(after) &&
                (previousCodeCharacter === "" || previousCodeCharacter === ";" || previousCodeCharacter === "}")
            ) {
                return cursor;
            }
        }
        if (!isAsciiWhitespace(character)) previousCodeCharacter = character;
    }
    return -1;
}

function findMatchingBrace(text: string, open: number): number {
    let depth = 0;
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = open; index < text.length; index += 1) {
        const character = text[index] ?? "";
        const next = text[index + 1] ?? "";
        if (lineComment) {
            if (character === "\n" || character === "\r") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === "*" && next === "/") {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote !== null) {
            if (character === "\\") escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "/" && next === "/") {
            lineComment = true;
            index += 1;
        } else if (character === "/" && next === "*") {
            blockComment = true;
            index += 1;
        } else if (character === "'" || character === '"' || character === "`") {
            quote = character;
        } else if (character === "{") depth += 1;
        else if (character === "}") {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

function readStaticObjectString(objectText: string, key: string): string | undefined {
    const matches: string[] = [];
    for (const rawField of splitTopLevelObjectFields(stripJavaScriptComments(objectText))) {
        const separator = findTopLevelColon(rawField);
        if (separator === -1) continue;
        const rawKey = rawField.slice(0, separator).trim();
        const propertyName = readStaticPropertyName(rawKey);
        if (propertyName !== key) continue;
        const value = readStaticStringLiteral(rawField.slice(separator + 1).trim());
        if (value === undefined) return undefined;
        matches.push(value);
    }
    return matches.length === 1 ? matches[0] : undefined;
}

function stripJavaScriptComments(text: string): string {
    let result = "";
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] ?? "";
        const next = text[index + 1] ?? "";
        if (lineComment) {
            if (character === "\n" || character === "\r") {
                lineComment = false;
                result += character;
            } else result += " ";
            continue;
        }
        if (blockComment) {
            if (character === "*" && next === "/") {
                result += "  ";
                blockComment = false;
                index += 1;
            } else result += character === "\n" || character === "\r" ? character : " ";
            continue;
        }
        if (quote !== null) {
            result += character;
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "/" && next === "/") {
            result += "  ";
            lineComment = true;
            index += 1;
        } else if (character === "/" && next === "*") {
            result += "  ";
            blockComment = true;
            index += 1;
        } else {
            result += character;
            if (character === "'" || character === '"' || character === "`") {
                quote = character;
            }
        }
    }
    return result;
}

function splitTopLevelObjectFields(text: string): string[] {
    const fields: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] ?? "";
        if (quote !== null) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "'" || character === '"' || character === "`") quote = character;
        else if (character === "{" || character === "[" || character === "(") depth += 1;
        else if (character === "}" || character === "]" || character === ")") {
            depth = Math.max(0, depth - 1);
        } else if (character === "," && depth === 0) {
            fields.push(text.slice(start, index));
            start = index + 1;
        }
    }
    fields.push(text.slice(start));
    return fields;
}

function findTopLevelColon(text: string): number {
    let depth = 0;
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] ?? "";
        if (quote !== null) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "'" || character === '"' || character === "`") quote = character;
        else if (character === "{" || character === "[" || character === "(") depth += 1;
        else if (character === "}" || character === "]" || character === ")") {
            depth = Math.max(0, depth - 1);
        } else if (character === ":" && depth === 0) return index;
    }
    return -1;
}

function readStaticPropertyName(raw: string): string | undefined {
    if (raw !== "" && [...raw].every(isIdentifierCharacter)) return raw;
    return readStaticStringLiteral(raw);
}

function readStaticStringLiteral(raw: string): string | undefined {
    const quote = raw[0];
    if (quote !== "'" && quote !== '"') return undefined;
    let escaped = false;
    for (let index = 1; index < raw.length; index += 1) {
        const character = raw[index] ?? "";
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (character !== quote) continue;
        if (raw.slice(index + 1).trim() !== "") return undefined;
        const literal = raw.slice(0, index + 1);
        if (quote === '"') {
            try {
                return JSON.parse(literal) as string;
            } catch {
                return undefined;
            }
        }
        return literal.slice(1, -1).split("\\'").join("'").split("\\\\").join("\\");
    }
    return undefined;
}

function isIdentifierCharacter(value: string): boolean {
    const code = value.charCodeAt(0);
    return (
        value === "_" || value === "$" || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    );
}
