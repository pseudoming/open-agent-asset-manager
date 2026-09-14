/** Antigravity field access over the runtime-neutral bounded frontmatter engine. */

import {
    parseBoundedFrontmatter,
    type BoundedFrontmatterScalar,
    type BoundedFrontmatterValue,
    type ParsedBoundedFrontmatter,
} from "@oaam/adapter-framework";
export {
    boundedFrontmatterBoolean as antigravityFrontmatterBoolean,
    boundedFrontmatterString as antigravityFrontmatterString,
    boundedFrontmatterStringList as antigravityFrontmatterStrings,
    boundedFrontmatterStringMap as antigravityFrontmatterStringMap,
} from "@oaam/adapter-framework";

export type AntigravityFrontmatterScalar = BoundedFrontmatterScalar;
export type AntigravityFrontmatterValue = BoundedFrontmatterValue;
export type ParsedAntigravityFrontmatter = ParsedBoundedFrontmatter;

/**
 * Antigravity declarations observed by OAAM use plain keys, balanced comma
 * delimiters, and string-only nested maps. Field meaning remains local.
 */
export function parseAntigravityFrontmatter(content: string): ParsedAntigravityFrontmatter {
    return parseBoundedFrontmatter(content, {
        mappingKeys: "plain",
        nestedMapValues: "string",
        inlineListNesting: "balanced",
    });
}
