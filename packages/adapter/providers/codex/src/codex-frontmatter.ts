/** Codex Skill frontmatter over the runtime-neutral bounded parser. */

import { parseBoundedFrontmatter, type BoundedFrontmatterValue, type ParsedBoundedFrontmatter } from "@oaam/adapter-framework";

export {
    boundedFrontmatterString as frontmatterString,
    boundedFrontmatterStringMap as frontmatterStringMap,
} from "@oaam/adapter-framework";

export type CodexFrontmatterValue = BoundedFrontmatterValue;
export type ParsedCodexFrontmatter = ParsedBoundedFrontmatter;

export function parseCodexFrontmatter(content: string): ParsedCodexFrontmatter {
    return parseBoundedFrontmatter(content, {
        mappingKeys: "plain",
        nestedMapValues: "string",
        inlineListNesting: "flat",
    });
}
