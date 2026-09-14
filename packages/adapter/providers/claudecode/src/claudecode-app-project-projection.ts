/** Project-location projection from App Code metadata; other values are never decoded. */
export const CLAUDE_APP_PROJECT_MAXIMUM_BYTES = 2 * 1024 * 1024;

export interface ClaudeAppProjectLocator {
    originCwd: string;
    cwd: string;
    ssh: boolean;
    wslDistro: string | null;
}

export function projectClaudeAppLocation(text: string): ClaudeAppProjectLocator {
    const invalid = (): never => {
        throw new TypeError("Claude App project locator is invalid or exceeds its bound");
    };
    if (Buffer.byteLength(text) > CLAUDE_APP_PROJECT_MAXIMUM_BYTES) invalid();
    let offset = 0;
    const result: ClaudeAppProjectLocator = { originCwd: "", cwd: "", ssh: false, wslDistro: null };
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
                if (offset - start > 4096 * 6 + 2) return invalid();
                const decoded: string = JSON.parse(text.slice(start, offset));
                if (Buffer.byteLength(decoded) > 4096 || decoded.includes("\0")) return invalid();
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
    const object = (depth: number, mode: "root" | "wsl" | "skip"): void => {
        consume("{");
        const seen = new Set<string>();
        whitespace();
        if (text[offset] === "}") {
            offset++;
            if (mode === "wsl") invalid();
            return;
        }
        while (true) {
            const key = string(mode !== "skip");
            consume(":");
            whitespace();
            const selected =
                mode === "root"
                    ? ["originCwd", "cwd", "sshConfig", "wslConfig"].includes(key)
                    : mode === "wsl" && key === "distro";
            if (selected) {
                if (seen.has(key)) invalid();
                seen.add(key);
                if (key === "originCwd" || key === "cwd") result[key] = string(true);
                else if (key === "distro") {
                    result.wslDistro = string(true);
                    const distro = result.wslDistro;
                    if (
                        distro.length === 0 ||
                        distro.length > 255 ||
                        distro === "." ||
                        distro === ".." ||
                        distro.trim() !== distro ||
                        distro.endsWith(".") ||
                        [...distro].some((character) => character.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(character))
                    )
                        invalid();
                } else if (text.startsWith("null", offset)) offset += 4;
                else if (key === "wslConfig") object(depth + 1, "wsl");
                else {
                    if (text[offset] !== "{") invalid();
                    result.ssh = true;
                    object(depth + 1, "skip");
                }
            } else value(depth + 1);
            whitespace();
            if (text[offset] === "}") {
                offset++;
                if (mode === "wsl" && result.wslDistro === null) invalid();
                return;
            }
            consume(",");
        }
    };
    const value = (depth: number): void => {
        if (depth > 64) invalid();
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
    return result;
}
