import * as childProcess from "node:child_process";

type WslDistributionQuery = "installed" | "running";

/**
 * Query the one reviewed WSL distribution command and normalize its output.
 * Whether and when this query is meaningful remains target-implementation
 * policy; this helper owns only the identical command/output mechanics.
 */
export function queryWslDistroNames(query: WslDistributionQuery = "installed"): string[] {
    try {
        const output = childProcess.execSync(query === "running" ? "wsl.exe -l --running -q" : "wsl.exe -l -q", {
            timeout: 5000,
        });
        return decodeWslCommandOutput(output)
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(isSafeDistroName)
            .filter((line, index, values) => values.indexOf(line) === index);
    } catch {
        return [];
    }
}

export function queryWslHomePath(distroName: string): string | null {
    if (!isSafeDistroName(distroName)) return null;
    try {
        const output = childProcess.execFileSync("wsl.exe", ["-d", distroName, "--exec", "printenv", "HOME"], {
            timeout: 5000,
        });
        const value = decodeWslCommandOutput(output).replace(/[\r\n]+$/u, "");
        return value.includes("\n") || value.includes("\r") ? null : value;
    } catch {
        return null;
    }
}

export function isSafeDistroName(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        value.trim() === value &&
        !value.endsWith(".") &&
        !value.endsWith(" ") &&
        ![...value].some((character) => character.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(character))
    );
}

function decodeWslCommandOutput(output: string | Buffer): string {
    if (typeof output === "string") return output.replace(/^\uFEFF/u, "");
    const utf16 =
        output.length >= 2 &&
        output.length % 2 === 0 &&
        ((output[0] === 0xff && output[1] === 0xfe) || hasUtf16LeNullPattern(output));
    return output.toString(utf16 ? "utf16le" : "utf8").replace(/^\uFEFF/u, "");
}

function hasUtf16LeNullPattern(output: Buffer): boolean {
    let sampledPairs = 0;
    let nullHighBytes = 0;
    for (let index = 0; index + 1 < output.length && sampledPairs < 32; index += 2) {
        sampledPairs += 1;
        if (output[index + 1] === 0) nullHighBytes += 1;
    }
    return sampledPairs > 0 && nullHighBytes * 4 >= sampledPairs * 3;
}
