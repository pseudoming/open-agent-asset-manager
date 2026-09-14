/** Canonical media-type spelling and logical-path inference. */

import type { ContentKind } from "../contracts/primitives";

const BINARY_MEDIA_TYPE = "application/octet-stream";
const TEXT_EXTENSION_MEDIA_TYPES = Object.freeze(
    new Map<string, string>([
        [".json", "application/json"],
        [".jsonc", "application/json"],
        [".js", "text/javascript"],
        [".markdown", "text/markdown"],
        [".md", "text/markdown"],
        [".mjs", "text/javascript"],
        [".ts", "text/typescript"],
        [".txt", "text/plain"],
        [".yaml", "application/yaml"],
        [".yml", "application/yaml"],
    ]),
);

export function canonicalMediaType(input: string): string {
    const trimmed = input.trim().toLowerCase();
    if (trimmed.length === 0) return BINARY_MEDIA_TYPE;
    const separator = trimmed.indexOf(";");
    const base = separator < 0 ? trimmed : trimmed.slice(0, separator).trim();
    return base.length === 0 ? BINARY_MEDIA_TYPE : base;
}

/**
 * Infer canonical Version-file metadata. Binary content never inherits a text
 * type from its filename; unknown text extensions use the safe OAAM fallback.
 */
export function inferCanonicalMediaType(logicalPath: string, contentKind: ContentKind): string {
    if (contentKind === "binary") return BINARY_MEDIA_TYPE;
    const lowered = logicalPath.toLowerCase();
    for (const [extension, mediaType] of TEXT_EXTENSION_MEDIA_TYPES) {
        if (lowered.endsWith(extension)) return mediaType;
    }
    return BINARY_MEDIA_TYPE;
}
