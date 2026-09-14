/** Claude Code field and executable-prompt semantics over the shared bounded parser. */

import {
    isAsciiWhitespace,
    parseBoundedFrontmatter,
    splitBoundedDelimited,
    type BoundedFrontmatterScalar,
    type BoundedFrontmatterValue,
    type ParsedBoundedFrontmatter,
} from "@oaam/adapter-framework";
export {
    boundedFrontmatterBoolean as frontmatterBoolean,
    boundedFrontmatterFiniteNumber as frontmatterNumber,
    boundedFrontmatterString as frontmatterString,
    boundedFrontmatterStringList as frontmatterStrings,
    boundedFrontmatterStringMap as frontmatterStringMap,
} from "@oaam/adapter-framework";

export type FrontmatterScalar = BoundedFrontmatterScalar;
export type FrontmatterValue = BoundedFrontmatterValue;
export type ParsedClaudeFrontmatter = ParsedBoundedFrontmatter;

/**
 * Claude Code declarations use plain keys, balanced comma delimiters, and
 * string-only nested maps. Unsupported YAML remains diagnostic-only.
 */
export function parseClaudeFrontmatter(content: string): ParsedClaudeFrontmatter {
    return parseBoundedFrontmatter(content, {
        mappingKeys: "plain",
        nestedMapValues: "string",
        inlineListNesting: "balanced",
    });
}

/** Split comma-delimited selectors without breaking commas inside parens/quotes. */
export function splitDelimited(value: string): string[] {
    return splitBoundedDelimited(value, true);
}

export function containsExecutablePromptSubstitution(body: string): boolean {
    if (containsExecutableFence(body)) return true;
    let cursor = body.indexOf("!`");
    while (cursor !== -1) {
        const previous = cursor === 0 ? "" : (body[cursor - 1] ?? "");
        const closing = body.indexOf("`", cursor + 2);
        if ((cursor === 0 || isAsciiWhitespace(previous)) && closing > cursor + 2) return true;
        cursor = body.indexOf("!`", cursor + 2);
    }
    return false;
}

function containsExecutableFence(body: string): boolean {
    let cursor = body.indexOf("```!");
    while (cursor !== -1) {
        const contentStart = cursor + 4;
        const closing = body.indexOf("```", contentStart);
        if (closing !== -1 && body.slice(contentStart, closing).trim() !== "") return true;
        cursor = body.indexOf("```!", contentStart);
    }
    return false;
}
