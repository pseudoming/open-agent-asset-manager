/** Decode only direct root.projects keys. Values are validated and skipped without materializing them. */
export const CLAUDE_PROJECT_REGISTRY_MAXIMUM_BYTES = 2 * 1024 * 1024;
const MAXIMUM_KEYS = 1024;
const MAXIMUM_KEY_BYTES = 4096;
const MAXIMUM_DEPTH = 64;

export function projectClaudeRegistryKeys(text: string): string[] {
    const invalid = (): never => {
        throw new TypeError("Claude project locator projection is invalid or exceeds its bound");
    };
    if (Buffer.byteLength(text) > CLAUDE_PROJECT_REGISTRY_MAXIMUM_BYTES) invalid();
    let offset = 0;
    let projectsSeen = false;
    const keys = new Set<string>();
    const scalarPattern = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/uy;
    const whitespace = (): void => {
        while (/^[\t\n\r ]$/u.test(text[offset] ?? "")) offset++;
    };
    const consume = (expected: string): void => {
        whitespace();
        if (text[offset++] !== expected) invalid();
    };
    const string = (capture: boolean): string => {
        whitespace();
        const start = offset;
        if (text[offset++] !== '"') return invalid();
        while (offset < text.length) {
            const character = text[offset++];
            if (character === '"') {
                if (!capture) return "";
                if (offset - start > MAXIMUM_KEY_BYTES * 6 + 2) return invalid();
                const decoded: string = JSON.parse(text.slice(start, offset));
                if (Buffer.byteLength(decoded) > MAXIMUM_KEY_BYTES) return invalid();
                return decoded;
            }
            if (character === "\\") {
                const escapeCode = text[offset++];
                if (escapeCode === "u") {
                    if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset, offset + 4))) return invalid();
                    offset += 4;
                } else if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) return invalid();
            } else if (character === undefined || character.charCodeAt(0) < 0x20) return invalid();
        }
        return invalid();
    };
    const object = (depth: number, mode: "root" | "projects" | "skip"): void => {
        consume("{");
        whitespace();
        if (text[offset] === "}") {
            offset++;
            return;
        }
        while (true) {
            const key = string(mode !== "skip");
            consume(":");
            if (mode === "root" && key === "projects") {
                if (projectsSeen) invalid();
                projectsSeen = true;
                object(depth + 1, "projects");
            } else {
                if (mode === "projects") {
                    if (keys.size === MAXIMUM_KEYS || keys.has(key) || key.trim() === "" || key.includes("\0")) invalid();
                    keys.add(key);
                }
                value(depth + 1);
            }
            whitespace();
            if (text[offset] === "}") {
                offset++;
                return;
            }
            consume(",");
        }
    };
    const value = (depth: number): void => {
        if (depth > MAXIMUM_DEPTH) invalid();
        whitespace();
        const character = text[offset];
        if (character === "{") {
            object(depth, "skip");
            return;
        }
        if (character === '"') {
            string(false);
            return;
        }
        if (character === "[") {
            offset++;
            whitespace();
            if (text[offset] === "]") {
                offset++;
                return;
            }
            while (true) {
                value(depth + 1);
                whitespace();
                if (text[offset] === "]") {
                    offset++;
                    return;
                }
                consume(",");
            }
        }
        scalarPattern.lastIndex = offset;
        const scalar = scalarPattern.exec(text);
        if (scalar === null) invalid();
        else offset += scalar[0].length;
    };
    object(0, "root");
    whitespace();
    if (offset !== text.length) invalid();
    return [...keys];
}
