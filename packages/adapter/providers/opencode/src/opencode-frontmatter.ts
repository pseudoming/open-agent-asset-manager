/** OpenCode field access over the runtime-neutral bounded frontmatter engine. */

import {
    parseBoundedFrontmatter,
    type BoundedFrontmatterScalar,
    type BoundedFrontmatterValue,
    type ParsedBoundedFrontmatter,
} from "@oaam/adapter-framework";
export {
    boundedFrontmatterBoolean as frontmatterBoolean,
    boundedFrontmatterFiniteNumber as frontmatterNumber,
    boundedFrontmatterScalarMap as frontmatterMap,
    boundedFrontmatterString as frontmatterString,
} from "@oaam/adapter-framework";

export type OpencodeFrontmatterScalar = BoundedFrontmatterScalar;
export type OpencodeFrontmatterValue = BoundedFrontmatterValue;
export type ParsedOpencodeFrontmatter = ParsedBoundedFrontmatter;

/** OpenCode additionally accepts quoted map keys and scalar-valued nested maps. */
export function parseOpencodeFrontmatter(content: string): ParsedOpencodeFrontmatter {
    return parseBoundedFrontmatter(content, {
        mappingKeys: "quoted_scalar",
        nestedMapValues: "non_null_scalar",
        inlineListNesting: "flat",
    });
}
