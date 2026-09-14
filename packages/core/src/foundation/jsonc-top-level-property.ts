/** Bounded, byte-preserving access to one top-level JSON/JSONC property value. */

export interface JsoncTopLevelPropertyValue {
    propertyName: string;
    valueBytes: Uint8Array;
    valueStart: number;
    valueEnd: number;
}

interface PropertySpan {
    name: string;
    valueStart: number;
    valueEnd: number;
}

interface ParsedObject {
    text: string;
    properties: PropertySpan[];
}

export function readJsoncTopLevelPropertyValue(bytes: Uint8Array, propertyName: string): JsoncTopLevelPropertyValue | null {
    requirePropertyName(propertyName);
    const parsed = parseRootObject(bytes);
    const matches = parsed.properties.filter((property) => property.name === propertyName);
    if (matches.length === 0) return null;
    const [match] = matches as [PropertySpan];
    return {
        propertyName,
        valueBytes: new TextEncoder().encode(parsed.text.slice(match.valueStart, match.valueEnd)),
        valueStart: match.valueStart,
        valueEnd: match.valueEnd,
    };
}

export function replaceJsoncTopLevelPropertyValue(
    containerBytes: Uint8Array | null,
    propertyName: string,
    replacementValueBytes: Uint8Array,
): Uint8Array {
    requirePropertyName(propertyName);
    const replacement = decodeStrict(replacementValueBytes);
    validateOneJsoncValue(replacement);
    if (containerBytes === null) {
        return new TextEncoder().encode(`{\n  ${JSON.stringify(propertyName)}: ${replacement}\n}\n`);
    }
    const parsed = parseRootObject(containerBytes);
    const matches = parsed.properties.filter((property) => property.name === propertyName);
    if (matches.length === 0) throw new Error(`top-level JSONC property is missing: ${propertyName}`);
    const [match] = matches as [PropertySpan];
    return new TextEncoder().encode(parsed.text.slice(0, match.valueStart) + replacement + parsed.text.slice(match.valueEnd));
}

export function jsoncDiffIsOneTopLevelPropertyValue(
    appliedBytes: Uint8Array,
    currentBytes: Uint8Array,
    propertyName: string,
): { appliedValueBytes: Uint8Array; currentValueBytes: Uint8Array } | null {
    try {
        const applied = parseRootObject(appliedBytes);
        const current = parseRootObject(currentBytes);
        const appliedMatches = applied.properties.filter((property) => property.name === propertyName);
        const currentMatches = current.properties.filter((property) => property.name === propertyName);
        if (appliedMatches.length !== 1 || currentMatches.length !== 1) return null;
        const [left] = appliedMatches as [PropertySpan];
        const [right] = currentMatches as [PropertySpan];
        if (
            applied.text.slice(0, left.valueStart) !== current.text.slice(0, right.valueStart) ||
            applied.text.slice(left.valueEnd) !== current.text.slice(right.valueEnd)
        ) {
            return null;
        }
        return {
            appliedValueBytes: new TextEncoder().encode(applied.text.slice(left.valueStart, left.valueEnd)),
            currentValueBytes: new TextEncoder().encode(current.text.slice(right.valueStart, right.valueEnd)),
        };
    } catch {
        return null;
    }
}

function parseRootObject(bytes: Uint8Array): ParsedObject {
    const text = decodeStrict(bytes);
    let index = 0;
    index = skipTrivia(text, index);
    if (text[index] !== "{") throw new Error("JSONC container must be one top-level object");
    index += 1;
    const properties: PropertySpan[] = [];
    const names = new Set<string>();
    index = skipTrivia(text, index);
    if (text[index] === "}") {
        index = skipTrivia(text, index + 1);
        if (index !== text.length) throw new Error("JSONC container has trailing data");
        return validatedObject(text, properties);
    }
    while (index < text.length) {
        index = skipTrivia(text, index);
        const key = consumeString(text, index);
        const name = JSON.parse(text.slice(index, key.end)) as string;
        if (names.has(name)) throw new Error(`duplicate top-level JSONC property: ${name}`);
        names.add(name);
        index = skipTrivia(text, key.end);
        if (text[index] !== ":") throw new Error("JSONC property is missing ':'");
        const valueStart = skipTrivia(text, index + 1);
        const valueEnd = consumeValue(text, valueStart);
        properties.push({ name, valueStart, valueEnd });
        index = skipTrivia(text, valueEnd);
        if (text[index] === "}") {
            index = skipTrivia(text, index + 1);
            if (index !== text.length) throw new Error("JSONC container has trailing data");
            return validatedObject(text, properties);
        }
        if (text[index] !== ",") throw new Error("JSONC properties require ',' separators");
        index = skipTrivia(text, index + 1);
        if (text[index] === "}") {
            index = skipTrivia(text, index + 1);
            if (index !== text.length) throw new Error("JSONC container has trailing data");
            return validatedObject(text, properties);
        }
    }
    throw new Error("JSONC container is unterminated");
}

function consumeValue(text: string, start: number): number {
    if (start >= text.length) throw new Error("JSONC value is missing");
    const first = text[start];
    if (first === '"') return consumeString(text, start).end;
    if (first === "{" || first === "[") {
        const stack: string[] = [first === "{" ? "}" : "]"];
        let index = start + 1;
        while (index < text.length) {
            const character = text[index];
            if (character === '"') {
                index = consumeString(text, index).end;
                continue;
            }
            if (character === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
                index = skipComment(text, index);
                continue;
            }
            if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
            else if (character === "}" || character === "]") {
                if (stack.pop() !== character) throw new Error("JSONC value has mismatched delimiters");
                if (stack.length === 0) return index + 1;
            }
            index += 1;
        }
        throw new Error("JSONC value is unterminated");
    }
    let index = start;
    while (index < text.length && text[index] !== "," && text[index] !== "}" && !isTriviaStart(text, index)) index += 1;
    if (index === start) throw new Error("JSONC primitive value is missing");
    validateOneJsoncValue(text.slice(start, index));
    return index;
}

function consumeString(text: string, start: number): { end: number } {
    if (text[start] !== '"') throw new Error("JSONC property name/value must be quoted");
    let index = start + 1;
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code === 0x22) return { end: index + 1 };
        if (code === 0x5c) {
            index += 2;
            continue;
        }
        if (code < 0x20) throw new Error("JSONC string contains a control character");
        index += 1;
    }
    throw new Error("JSONC string is unterminated");
}

function skipTrivia(text: string, start: number): number {
    let index = start;
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
            index += 1;
            continue;
        }
        if (text[index] === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
            index = skipComment(text, index);
            continue;
        }
        return index;
    }
    return index;
}

function skipComment(text: string, start: number): number {
    if (text[start + 1] === "/") {
        const end = text.indexOf("\n", start + 2);
        return end === -1 ? text.length : end + 1;
    }
    const end = text.indexOf("*/", start + 2);
    if (end === -1) throw new Error("JSONC block comment is unterminated");
    return end + 2;
}

function isTriviaStart(text: string, index: number): boolean {
    const code = text.charCodeAt(index);
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || text[index] === "/";
}

function validateOneJsoncValue(text: string): void {
    JSON.parse(stripJsonc(text));
}

function validatedObject(text: string, properties: PropertySpan[]): ParsedObject {
    JSON.parse(stripJsonc(text));
    return { text, properties };
}

function stripJsonc(text: string): string {
    let result = "";
    let index = 0;
    while (index < text.length) {
        if (text[index] === '"') {
            const string = consumeString(text, index);
            result += text.slice(index, string.end);
            index = string.end;
            continue;
        }
        if (text[index] === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
            const end = skipComment(text, index);
            result += " ".repeat(end - index);
            index = end;
            continue;
        }
        result += text[index];
        index += 1;
    }
    return removeTrailingCommas(result);
}

function removeTrailingCommas(text: string): string {
    let result = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] as string;
        if (inString) {
            result += character;
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            result += character;
            continue;
        }
        if (character !== ",") {
            result += character;
            continue;
        }
        let lookahead = index + 1;
        while (/\s/u.test(text.charAt(lookahead))) lookahead += 1;
        if (text[lookahead] !== "}" && text[lookahead] !== "]") result += character;
    }
    return result;
}

function decodeStrict(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requirePropertyName(propertyName: string): void {
    if (propertyName.trim() === "" || propertyName !== propertyName.trim() || propertyName.includes("\0")) {
        throw new Error("JSONC property name must be canonical non-blank text");
    }
}
