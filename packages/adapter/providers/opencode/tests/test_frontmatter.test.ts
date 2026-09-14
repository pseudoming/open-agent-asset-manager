import { describe, expect, it } from "vitest";
import {
    frontmatterBoolean,
    frontmatterMap,
    frontmatterNumber,
    frontmatterString,
    parseOpencodeFrontmatter,
} from "../src/opencode-frontmatter";

describe("bounded OpenCode frontmatter parser", () => {
    it("parses scalar, list, and one-level map values without executing YAML", () => {
        const parsed = parseOpencodeFrontmatter(
            [
                "---",
                "name: 'reviewer'",
                'description: "Review # safely" # comment',
                "disable: false",
                "temperature: 0.5",
                "labels: [one, 'two']",
                "tools:",
                "  read: true",
                "  shell: false",
                "  '*': ask",
                "---",
                "Review carefully.",
                "",
            ].join("\n"),
        );
        expect(parsed).toMatchObject({
            hasFrontmatter: true,
            closed: true,
            body: "Review carefully.\n",
            diagnostics: [],
        });
        expect(frontmatterString(parsed, "name")).toBe("reviewer");
        expect(frontmatterString(parsed, "description")).toBe("Review # safely");
        expect(frontmatterBoolean(parsed, "disable")).toBe(false);
        expect(frontmatterNumber(parsed, "temperature")).toBe(0.5);
        expect(parsed.values.labels).toEqual(["one", "two"]);
        expect(frontmatterMap(parsed, "tools")).toEqual({ read: true, shell: false, "*": "ask" });
    });

    it("leaves a plain Markdown document untouched", () => {
        expect(parseOpencodeFrontmatter("# Plain\n")).toEqual({
            hasFrontmatter: false,
            closed: false,
            values: {},
            presentKeys: [],
            body: "# Plain\n",
            diagnostics: [],
        });
    });

    it("marks an unclosed frontmatter block instead of guessing its body", () => {
        const content = "---\nname: broken\nbody";
        expect(parseOpencodeFrontmatter(content)).toMatchObject({
            hasFrontmatter: true,
            closed: false,
            values: {},
            body: content,
            diagnostics: ["frontmatter is not closed"],
        });
    });

    it("diagnoses duplicate, mixed, orphan, and executable YAML shapes", () => {
        const parsed = parseOpencodeFrontmatter(
            [
                "---",
                "name: first",
                "name: second",
                "  orphan: value",
                "items:",
                "  - one",
                "  key: value",
                "script: |",
                "  echo unsafe",
                "---",
                "Body",
            ].join("\n"),
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                "duplicate frontmatter key name",
                "orphan nested frontmatter line 4",
                "mixed list/map value for items",
                "unsupported value for frontmatter key script",
                "orphan nested frontmatter line 9",
            ]),
        );
    });

    it("returns undefined from typed accessors when a field has another type", () => {
        const parsed = parseOpencodeFrontmatter("---\nname: true\ndisable: nope\ntemperature: cold\ntools: []\n---\nBody");
        expect(frontmatterString(parsed, "name")).toBeUndefined();
        expect(frontmatterBoolean(parsed, "disable")).toBeUndefined();
        expect(frontmatterNumber(parsed, "temperature")).toBeUndefined();
        expect(frontmatterMap(parsed, "tools")).toBeUndefined();
    });

    it("diagnoses every bounded nested-container failure without evaluating YAML", () => {
        const parsed = parseOpencodeFrontmatter(
            [
                "---",
                "# comment",
                "\tbad: tabbed",
                "not-a-pair",
                "list:",
                "  -",
                "  - |",
                "  - one",
                "  key: mixed",
                "record:",
                "  key: value",
                "  key: duplicate",
                "  __proto__: unsafe",
                "  bad: {nested}",
                "  no-pair",
                "  - mixed",
                "constructor: unsafe",
                "scalar: value",
                "  orphan: value",
                'broken-double: "unterminated',
                'broken-json: "\\x"',
                "broken-single: 'unterminated",
                "block: >",
                "---",
                "Body\r",
            ].join("\r\n"),
        );
        expect(parsed.body).toBe("Body\r");
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                "unsupported tab indentation on frontmatter line 3",
                "unsupported frontmatter line 4",
                "invalid list item for list",
                "unsupported list item for list",
                "mixed list/map value for list",
                "duplicate map key record.key",
                "unsafe map key record.__proto__",
                "unsupported map value for record.bad",
                "unsupported nested value for record",
                "mixed list/map value for record",
                "unsafe frontmatter key constructor",
                "orphan nested frontmatter line 19",
                "unsupported value for frontmatter key broken-double",
                "unsupported value for frontmatter key broken-json",
                "unsupported value for frontmatter key broken-single",
                "unsupported value for frontmatter key block",
            ]),
        );
    });

    it("parses comments, nulls, escaped arrays, and an empty map as literal data", () => {
        const parsed = parseOpencodeFrontmatter(
            [
                "---",
                "empty: # trailing comment",
                "null-word: null",
                "null-tilde: ~",
                "quoted: 'it''s # literal' # removed",
                'array: ["a,b", \'c\', "d\\\\e"] # comment',
                "map: {}",
                "integer: 4",
                "noncanonical-number: 04",
                "---",
                "Body",
            ].join("\n"),
        );
        expect(parsed.values).toMatchObject({
            empty: "",
            "null-word": null,
            "null-tilde": null,
            quoted: "it's # literal",
            array: ["a,b", "c", "d\\e"],
            map: {},
            integer: 4,
            "noncanonical-number": "04",
        });
        expect(parsed.diagnostics).toEqual([]);
    });
});
