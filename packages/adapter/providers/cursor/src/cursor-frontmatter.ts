/** Cursor `.mdc` frontmatter over the bounded runtime-neutral parser. */

import { parseBoundedFrontmatter, type ParsedBoundedFrontmatter } from "@oaam/adapter-framework";

export {
    boundedFrontmatterBoolean as cursorFrontmatterBoolean,
    boundedFrontmatterString as cursorFrontmatterString,
} from "@oaam/adapter-framework";

export function parseCursorFrontmatter(content: string): ParsedBoundedFrontmatter {
    const source = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
    return parseBoundedFrontmatter(source, {
        mappingKeys: "plain",
        nestedMapValues: "string",
        inlineListNesting: "flat",
    });
}
