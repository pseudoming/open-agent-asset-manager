import { describe, expect, it } from "vitest";
import {
    antigravityFrontmatterString,
    antigravityFrontmatterStringMap,
    antigravityFrontmatterStrings,
    parseAntigravityFrontmatter,
} from "../src/antigravity-frontmatter";

describe("Antigravity bounded frontmatter parser", () => {
    it("leaves plain Markdown untouched", () => {
        expect(parseAntigravityFrontmatter("# Body\n")).toMatchObject({
            hasFrontmatter: false,
            closed: false,
            body: "# Body\n",
            diagnostics: [],
        });
    });

    it("parses scalar, list, and strict string-map values", () => {
        const parsed = parseAntigravityFrontmatter(
            "---\nname: demo\npaths: [src/**, 'test/**']\nmetadata:\n  owner: oaam\n---\nBody\n",
        );
        expect(antigravityFrontmatterString(parsed, "name")).toBe("demo");
        expect(antigravityFrontmatterStrings(parsed, "paths")).toEqual(["src/**", "test/**"]);
        expect(antigravityFrontmatterStringMap(parsed, "metadata")).toEqual({ owner: "oaam" });
        expect(parsed.body).toBe("Body\n");
    });

    it("parses block string lists and comma-delimited strings", () => {
        const parsed = parseAntigravityFrontmatter("---\ntools:\n  - read\n  - write\nselectors: one, two\n---\nBody");
        expect(antigravityFrontmatterStrings(parsed, "tools")).toEqual(["read", "write"]);
        expect(antigravityFrontmatterStrings(parsed, "selectors")).toEqual(["one", "two"]);
    });

    it("reports an unclosed block without pretending its body was separated", () => {
        const parsed = parseAntigravityFrontmatter("---\nname: demo\nBody");
        expect(parsed.closed).toBe(false);
        expect(parsed.body).toBe("---\nname: demo\nBody");
        expect(parsed.diagnostics).toContain("frontmatter is not closed");
    });

    it("reports duplicate, orphan, mixed, and unsupported values", () => {
        const parsed = parseAntigravityFrontmatter(
            "---\nname: one\nname: two\n  orphan: value\nmixed:\n  - one\n  key: value\nblock: |\n---\nBody",
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                "duplicate frontmatter key name",
                "orphan nested frontmatter line 4",
                "mixed list/map value for mixed",
                "unsupported value for frontmatter key block",
            ]),
        );
    });

    it("rejects non-string map values and malformed quotes", () => {
        const parsed = parseAntigravityFrontmatter('---\nmetadata:\n  count: 2\nbad: "unterminated\n---\nBody');
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining(["non-string map value for metadata.count", "unsupported value for frontmatter key bad"]),
        );
    });

    it("does not coerce scalar and map values through typed accessors", () => {
        const parsed = parseAntigravityFrontmatter("---\nflag: true\nmetadata: text\n---\nBody");
        expect(antigravityFrontmatterString(parsed, "flag")).toBeUndefined();
        expect(antigravityFrontmatterStringMap(parsed, "metadata")).toBeUndefined();
    });

    it("covers every malformed nested-container shape without inventing values", () => {
        const parsed = parseAntigravityFrontmatter(
            "---\n# comment\n\n: empty-key\norphan line\ncontainer:\n  invalid\ninvalid-list:\n  -\nrecord:\n  key: value\n  key: duplicate\n  - list-after-map\nlist:\n  - one\n  key: map-after-list\nnonstring-map:\n  enabled: true\nunsupported-list:\n  - |\n---\nbody",
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining("unsupported frontmatter line"),
                expect.stringContaining("unsupported nested value"),
                expect.stringContaining("invalid list item"),
                expect.stringContaining("duplicate map key"),
                expect.stringContaining("mixed list/map"),
                expect.stringContaining("non-string map value"),
                expect.stringContaining("unsupported list item"),
            ]),
        );
    });

    it("parses bounded scalar forms, comments, CRLF, and nested delimiters", () => {
        const parsed = parseAntigravityFrontmatter(
            "---\r\nempty: null\r\ntilde: ~\r\nyes: true\r\nno: false\r\ncount: 2\r\nsingle: 'it''s fine'\r\nescaped: \"a\\\"b\"\r\nselectors: Read, Bash(git diff, --stat), [x,y], 'Write'\r\nemptyList: []\r\nemptyMap: {}\r\ncommented: value # trailing\r\ntabComment: value\t# trailing\r\ncrComment: value\r# trailing\r\nquotedComment: 'a # b' # trailing\r\n---\r\nbody\r\n",
        );
        expect(parsed.body).toBe("body\r\n");
        expect(parsed.values).toMatchObject({
            empty: null,
            tilde: null,
            yes: true,
            no: false,
            count: 2,
            single: "it's fine",
            escaped: 'a"b',
            emptyList: [],
            emptyMap: {},
            commented: "value",
            tabComment: "value",
            crComment: "value",
            quotedComment: "a # b",
        });
        expect(antigravityFrontmatterStrings(parsed, "selectors")).toEqual(["Read", "Bash(git diff, --stat)", "[x,y]", "Write"]);
        expect(antigravityFrontmatterStrings(parsed, "count")).toBeUndefined();
        expect(antigravityFrontmatterStrings(parsed, "emptyList")).toEqual([]);
    });

    it("rejects tabs, broken quoted escapes, inline block syntax, and mixed inline arrays", () => {
        const parsed = parseAntigravityFrontmatter(
            '---\nmetadata:\n\ttype: project\nbadDouble: "bad\\q"\nbadSingle: \'unterminated\nblock: >\ninlineMap: { key: value }\nmixed: [Read, 2, true]\ncommentOnly: # removed\n---\nbody\n',
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining("unsupported tab indentation"),
                "unsupported value for frontmatter key badDouble",
                "unsupported value for frontmatter key badSingle",
                "unsupported value for frontmatter key block",
                "unsupported value for frontmatter key inlineMap",
            ]),
        );
        expect(antigravityFrontmatterStrings(parsed, "mixed")).toBeUndefined();
        expect(antigravityFrontmatterString(parsed, "commentOnly")).toBe("");
        expect(antigravityFrontmatterStringMap(parsed, "metadata")).toBeUndefined();
    });

    it("handles escaped commas, unmatched delimiters, empty items, and quoted accessor fallbacks deterministically", () => {
        const parsed = parseAntigravityFrontmatter(
            '---\nvalues: , "a\\"b", nested(one,two), [x,y], trailing,\nbroken: "unterminated\n---\nbody',
        );
        expect(antigravityFrontmatterStrings(parsed, "values")).toEqual(['a"b', "nested(one,two)", "[x,y]", "trailing"]);
        expect(antigravityFrontmatterString(parsed, "broken")).toBe('"unterminated');
        expect(parsed.diagnostics).toContain("unsupported value for frontmatter key broken");
    });

    it("rejects prototype-mutating keys at both frontmatter levels", () => {
        const parsed = parseAntigravityFrontmatter(
            "---\nprototype: unsafe\nmetadata:\n  owner: oaam\n  __proto__: polluted\n---\nBody\n",
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining(["unsafe frontmatter key prototype", "unsafe map key metadata.__proto__"]),
        );
        expect(Object.hasOwn(parsed.values, "prototype")).toBe(false);
        expect(antigravityFrontmatterStringMap(parsed, "metadata")).toEqual({ owner: "oaam" });
        expect(Object.getPrototypeOf(parsed.values)).toBe(Object.prototype);
    });
});
