/** ZCode declaration frontmatter over the runtime-neutral bounded parser. */

import { parseBoundedFrontmatter, type ParsedBoundedFrontmatter } from "@oaam/adapter-framework";

export {
    boundedFrontmatterBoolean as frontmatterBoolean,
    boundedFrontmatterFiniteNumber as frontmatterNumber,
    boundedFrontmatterString as frontmatterString,
    boundedFrontmatterStringList as frontmatterStringList,
    boundedFrontmatterStringMap as frontmatterStringMap,
} from "@oaam/adapter-framework";

export function parseZcodeFrontmatter(content: string): ParsedBoundedFrontmatter {
    const source = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
    return parseBoundedFrontmatter(source, {
        mappingKeys: "plain",
        nestedMapValues: "string",
        inlineListNesting: "flat",
    });
}

export function parseZcodeSubagentFrontmatter(content: string): ParsedBoundedFrontmatter {
    const source = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
    const lines = source.split(/\r?\n/);
    if (!source.startsWith("---") || lines[0]?.trim() !== "---") return emptyCommandFrontmatter(source);
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closingIndex < 0) {
        return {
            hasFrontmatter: true,
            closed: false,
            values: {},
            presentKeys: [],
            body: source,
            diagnostics: ["frontmatter is not closed"],
        };
    }

    const values: ParsedBoundedFrontmatter["values"] = {};
    const presentKeys: string[] = [];
    const diagnostics: string[] = [];
    let activeListKey: string | undefined;
    for (const [index, rawLine] of lines.slice(1, closingIndex).entries()) {
        const line = rawLine.trimEnd();
        if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
        const listItem = subagentListItem(line);
        if (listItem !== undefined && activeListKey !== undefined) {
            const current = values[activeListKey];
            const items = Array.isArray(current) ? current : [];
            const parsedItem = parseSubagentScalar(listItem);
            if (Array.isArray(parsedItem)) {
                diagnostics.push(`unsupported nested list item for ${activeListKey}`);
                values[activeListKey] = [...items, null];
            } else {
                values[activeListKey] = [...items, parsedItem];
            }
            continue;
        }
        activeListKey = undefined;
        const pair = subagentKeyValue(line);
        if (pair === null) {
            diagnostics.push(`unsupported frontmatter line ${index + 2}`);
            continue;
        }
        const [key, rawValue] = pair;
        if (isUnsafeObjectKey(key)) {
            diagnostics.push(`unsafe frontmatter key ${key}`);
            continue;
        }
        if (Object.hasOwn(values, key)) diagnostics.push(`duplicate frontmatter key ${key}`);
        else presentKeys.push(key);
        if (rawValue === "") {
            values[key] = [];
            activeListKey = key;
        } else {
            values[key] = parseSubagentScalar(rawValue);
        }
    }
    return {
        hasFrontmatter: true,
        closed: true,
        values,
        presentKeys: presentKeys.sort(),
        body: lines.slice(closingIndex + 1).join("\n"),
        diagnostics,
    };
}

export function parseZcodeCommandFrontmatter(content: string): ParsedBoundedFrontmatter {
    const source = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
    const lines = source.split(/\r?\n/);
    if (!source.startsWith("---") || lines[0]?.trim() !== "---") return emptyCommandFrontmatter(source);
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closingIndex < 0) {
        return {
            hasFrontmatter: true,
            closed: false,
            values: {},
            presentKeys: [],
            body: source,
            diagnostics: ["frontmatter is not closed"],
        };
    }

    const values: ParsedBoundedFrontmatter["values"] = {};
    const presentKeys: string[] = [];
    const diagnostics: string[] = [];
    for (const [index, rawLine] of lines.slice(1, closingIndex).entries()) {
        if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#") || /^\s/.test(rawLine)) continue;
        const separator = rawLine.indexOf(":");
        if (separator <= 0) {
            diagnostics.push(`unsupported frontmatter line ${index + 2}`);
            continue;
        }
        const key = rawLine.slice(0, separator).trim();
        if (key === "" || isUnsafeObjectKey(key)) {
            diagnostics.push(`unsafe frontmatter key ${key}`);
            continue;
        }
        if (Object.hasOwn(values, key)) diagnostics.push(`duplicate frontmatter key ${key}`);
        else presentKeys.push(key);
        values[key] = unquoteCommandScalar(rawLine.slice(separator + 1).trim());
    }
    return {
        hasFrontmatter: true,
        closed: true,
        values,
        presentKeys: presentKeys.sort(),
        body: lines.slice(closingIndex + 1).join("\n"),
        diagnostics,
    };
}

function emptyCommandFrontmatter(content: string): ParsedBoundedFrontmatter {
    return { hasFrontmatter: false, closed: false, values: {}, presentKeys: [], body: content, diagnostics: [] };
}

function unquoteCommandScalar(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1).trim();
    }
    return value;
}

function subagentListItem(line: string): string | undefined {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("-") || trimmed.length < 2 || !isWhitespace(trimmed[1] ?? "")) return undefined;
    return trimmed.slice(1).trim();
}

function subagentKeyValue(line: string): [string, string] | null {
    if (!isAsciiLetter(line[0] ?? "")) return null;
    let keyEnd = 1;
    while (isAsciiLetterOrDigit(line[keyEnd] ?? "") || line[keyEnd] === "_" || line[keyEnd] === "-") keyEnd += 1;
    let separator = keyEnd;
    while (isWhitespace(line[separator] ?? "")) separator += 1;
    if (line[separator] !== ":") return null;
    return [line.slice(0, keyEnd), line.slice(separator + 1).trim()];
}

function parseSubagentScalar(value: string): string | number | boolean | Array<string | number | boolean> {
    const trimmed = stripSubagentInlineComment(value.trim());
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed !== "" && [...trimmed].every(isDigit)) return Number(trimmed);
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        return splitSubagentInlineList(trimmed.slice(1, -1)).map((item) =>
            unquoteSubagentScalar(stripSubagentInlineComment(item)),
        );
    }
    return unquoteSubagentScalar(trimmed);
}

function stripSubagentInlineComment(value: string): string {
    let quote: "'" | '"' | undefined;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if ((character === "'" || character === '"') && value[index - 1] !== "\\") {
            quote = quote === character ? undefined : (quote ?? character);
        }
        if (quote === undefined && character === "#" && isWhitespace(value[index - 1] ?? "")) {
            return value.slice(0, index).trimEnd();
        }
    }
    return value;
}

function splitSubagentInlineList(value: string): string[] {
    const result: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let depth = 0;
    for (const character of value) {
        if ((character === "'" || character === '"') && quote === undefined) {
            quote = character;
            current += character;
            continue;
        }
        if (character === quote) {
            quote = undefined;
            current += character;
            continue;
        }
        if (quote === undefined && character === "(") depth += 1;
        if (quote === undefined && character === ")" && depth > 0) depth -= 1;
        if (quote === undefined && depth === 0 && character === ",") {
            if (current.trim() !== "") result.push(current.trim());
            current = "";
        } else {
            current += character;
        }
    }
    if (current.trim() !== "") result.push(current.trim());
    return result;
}

function unquoteSubagentScalar(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        if ((first === "'" || first === '"') && value.at(-1) === first) return value.slice(1, -1);
    }
    return value;
}

function isUnsafeObjectKey(value: string): boolean {
    return value === "__proto__" || value === "constructor" || value === "prototype";
}

function isAsciiLetter(value: string): boolean {
    return (value >= "a" && value <= "z") || (value >= "A" && value <= "Z");
}

function isAsciiLetterOrDigit(value: string): boolean {
    return isAsciiLetter(value) || isDigit(value);
}

function isDigit(value: string): boolean {
    return value >= "0" && value <= "9";
}

function isWhitespace(value: string): boolean {
    return value === " " || value === "\t" || value === "\n" || value === "\r";
}
