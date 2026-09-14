/** Runtime-neutral text and portable-path mechanics shared by source readers. */

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function compareCodeUnitText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function isAsciiWhitespace(value: string): boolean {
    return value === " " || value === "\t" || value === "\n" || value === "\r";
}

export function decodeUtf8Strict(bytes: Uint8Array): string | null {
    try {
        return UTF8_DECODER.decode(bytes);
    } catch {
        return null;
    }
}

export function portableBasename(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator === -1 ? path : path.slice(separator + 1);
}

export function portableParentPath(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator === -1 ? "" : path.slice(0, separator);
}

export function portablePathWithoutExtension(path: string): string {
    const basenameStart = path.lastIndexOf("/") + 1;
    const extensionStart = path.lastIndexOf(".");
    return extensionStart <= basenameStart ? path : path.slice(0, extensionStart);
}

export function isPortablePathAtOrBelow(path: string, root: string): boolean {
    return root === "" || path === root || path.startsWith(`${root}/`);
}

export function normalizePortableRelativeReference(
    rawTarget: string,
    sourceParent: string,
    isExternalTarget: (value: string) => boolean,
): string | null {
    if (rawTarget === "" || isExternalTarget(rawTarget) || rawTarget.includes("\\") || rawTarget.includes("\0")) {
        return null;
    }

    const output = sourceParent === "" ? [] : sourceParent.split("/");
    if (
        output.some(
            (segment) =>
                segment === "" || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"),
        )
    ) {
        return null;
    }

    for (const segment of rawTarget.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            if (output.length === 0) return null;
            output.pop();
        } else {
            output.push(segment);
        }
    }
    return output.length === 0 ? null : output.join("/");
}

export function relativePortablePath(path: string, parent: string): string {
    return parent === "" ? path : path.slice(parent.length + 1);
}

export function isPortableSourcePattern(value: string): boolean {
    return (
        value.trim() !== "" &&
        !value.includes("\0") &&
        !value.includes("\\") &&
        !value.startsWith("/") &&
        value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

export function uniqueStringsPreservingOrder(values: string[]): string[] {
    return [...new Set(values)];
}

export function uniqueSortedStrings(values: string[]): string[] {
    return [...new Set(values)].sort(compareCodeUnitText);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trimNonBlankText(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function compareLogicalPath(left: { logicalPath: string }, right: { logicalPath: string }): number {
    return compareCodeUnitText(left.logicalPath, right.logicalPath);
}

export function unknownSourceKeys(source: { presentKeys: readonly string[] }, allowedKeys: readonly string[]): string[] {
    const allowed = new Set(allowedKeys);
    return source.presentKeys.filter((key) => !allowed.has(key));
}
