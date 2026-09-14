import { describe, expect, it } from "vitest";
import {
    boundedFrontmatterBoolean,
    boundedFrontmatterFiniteNumber,
    boundedFrontmatterScalarMap,
    boundedFrontmatterString,
    boundedFrontmatterStringList,
    boundedFrontmatterStringMap,
    parseBoundedFrontmatter,
    projectBoundedFrontmatterDiagnostics,
    splitBoundedDelimited,
    type ParsedBoundedFrontmatter,
} from "../src";

const STRICT = {
    mappingKeys: "plain",
    nestedMapValues: "string",
    inlineListNesting: "balanced",
} as const;

const SCALAR_MAP = {
    mappingKeys: "quoted_scalar",
    nestedMapValues: "non_null_scalar",
    inlineListNesting: "flat",
} as const;

describe("runtime-neutral bounded frontmatter engine", () => {
    it("keeps plain and unclosed documents intact", () => {
        expect(parseBoundedFrontmatter("plain\r", STRICT)).toEqual({
            hasFrontmatter: false,
            closed: false,
            values: {},
            presentKeys: [],
            body: "plain\r",
            diagnostics: [],
        });
        expect(parseBoundedFrontmatter("---\nname: x\nbody", STRICT)).toMatchObject({
            hasFrontmatter: true,
            closed: false,
            body: "---\nname: x\nbody",
            diagnostics: ["frontmatter is not closed"],
        });
    });

    it("projects unclosed and parser diagnostics in stable order without owning vocabulary", () => {
        const plain = parseBoundedFrontmatter("plain", STRICT);
        expect(
            projectBoundedFrontmatterDiagnostics(
                plain,
                () => "provider-unclosed",
                (message) => `provider-parser:${message}`,
            ),
        ).toEqual([]);

        const unclosed = parseBoundedFrontmatter("---\nname: x\nbody", STRICT);
        expect(
            projectBoundedFrontmatterDiagnostics(
                unclosed,
                () => "provider-unclosed",
                (message) => `provider-parser:${message}`,
            ),
        ).toEqual(["provider-unclosed", "provider-parser:frontmatter is not closed"]);

        const malformed = parseBoundedFrontmatter("---\nnot-a-pair\nduplicate: one\nduplicate: two\n---\nbody", STRICT);
        expect(
            projectBoundedFrontmatterDiagnostics(
                malformed,
                () => "provider-unclosed",
                (message) => `provider-parser:${message}`,
            ),
        ).toEqual(["provider-parser:unsupported frontmatter line 2", "provider-parser:duplicate frontmatter key duplicate"]);
    });

    it("parses the strict scalar, list, string-map, comments, and CRLF subset", () => {
        const parsed = parseBoundedFrontmatter(
            "---\r\n# comment\r\nname: demo\r\nempty: # comment\r\nnull: ~\r\nyes: true\r\nno: false\r\ncount: 2\r\nnoncanonical: 02\r\nsingle: 'it''s # safe' # removed\r\ndouble: \"a\\\"b\"\r\nlist: [Read, Bash(git diff, --stat), [x,y], 'Write']\r\nblock:\r\n  - one\r\n  - \"two\"\r\nmap:\r\n  owner: oaam\r\nemptyMap: {}\r\n---\r\nbody\r\n",
            STRICT,
        );
        expect(parsed).toMatchObject({
            closed: true,
            body: "body\r\n",
            diagnostics: [],
            values: {
                name: "demo",
                empty: "",
                null: null,
                yes: true,
                no: false,
                count: 2,
                noncanonical: "02",
                single: "it's # safe",
                double: 'a"b',
                list: ["Read", "Bash(git diff, --stat)", "[x,y]", "Write"],
                block: ["one", "two"],
                map: { owner: "oaam" },
                emptyMap: {},
            },
        });
        expect(parsed.presentKeys).toEqual([...parsed.presentKeys].sort());
    });

    it("diagnoses every rejected top-level and nested container shape", () => {
        const parsed = parseBoundedFrontmatter(
            '---\n\tbad: tabbed\nnot-a-pair\nduplicate: one\nduplicate: two\nprototype: unsafe\nscalar: value\n  orphan: value\nlist:\n  -\n  - |\n  - one\n  key: mixed\nrecord:\n  key: value\n  key: duplicate\n  __proto__: unsafe\n  enabled: true\n  no-pair\n  - mixed\nblock: |\nbrokenDouble: "unterminated\nbrokenJson: "\\x"\nbrokenSingle: \'unterminated\ninlineMap: {nested}\nmixedArray: [one, {two}]\n---\nbody',
            STRICT,
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                "unsupported tab indentation on frontmatter line 2",
                "unsupported frontmatter line 3",
                "duplicate frontmatter key duplicate",
                "unsafe frontmatter key prototype",
                "orphan nested frontmatter line 8",
                "invalid list item for list",
                "unsupported list item for list",
                "mixed list/map value for list",
                "duplicate map key record.key",
                "unsafe map key record.__proto__",
                "non-string map value for record.enabled",
                "unsupported nested value for record",
                "mixed list/map value for record",
                "unsupported value for frontmatter key block",
                "unsupported value for frontmatter key brokenDouble",
                "unsupported value for frontmatter key brokenJson",
                "unsupported value for frontmatter key brokenSingle",
                "unsupported value for frontmatter key inlineMap",
                "unsupported value for frontmatter key mixedArray",
            ]),
        );
    });

    it("supports OpenCode quoted keys and non-null scalar maps without widening strict maps", () => {
        const parsed = parseBoundedFrontmatter(
            '---\n"name": demo\ntools:\n  read: true\n  count: 2\n  empty: null\n  \'*\': ask\n  "bad: broken\n---\nbody',
            SCALAR_MAP,
        );
        expect(parsed.values).toMatchObject({
            name: "demo",
            tools: { read: true, count: 2, "*": "ask" },
        });
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining(["unsupported map value for tools.empty", "unsupported nested value for tools"]),
        );
        expect(parseBoundedFrontmatter('---\n"": value\n---\nbody', SCALAR_MAP).diagnostics).toEqual([
            "unsupported frontmatter line 2",
        ]);
        expect(parseBoundedFrontmatter("---\n\u00a0: value\n---\nbody", SCALAR_MAP).diagnostics).toEqual([
            "unsupported frontmatter line 2",
        ]);
    });

    it("splits balanced and flat comma forms and applies bounded quote fallbacks", () => {
        expect(splitBoundedDelimited(", Read, Bash(git diff, --stat), [x,y], 'Write',", true)).toEqual([
            "Read",
            "Bash(git diff, --stat)",
            "[x,y]",
            "Write",
        ]);
        expect(splitBoundedDelimited("one(two,three), four", false)).toEqual(["one(two", "three)", "four"]);
        expect(splitBoundedDelimited('x, "bad\\q", z', true)).toEqual(["x", "bad\\q", "z"]);
        expect(splitBoundedDelimited("a", true)).toEqual(["a"]);
    });

    it("reads typed values without assigning provider field meaning", () => {
        const parsed: ParsedBoundedFrontmatter = {
            hasFrontmatter: true,
            closed: true,
            values: {
                string: "value",
                boolean: true,
                number: 2,
                listText: "Read, Bash(git diff, --stat)",
                flatListText: "one(two,three), four",
                list: [" Read ", "", "Write"],
                mixedList: ["Read", false],
                stringMap: { owner: "oaam" },
                scalarMap: { enabled: true, count: 2, name: "oaam" },
                mixedMap: { owner: "oaam", enabled: true },
                nullValue: null,
            },
            presentKeys: [],
            body: "",
            diagnostics: [],
        };

        expect(boundedFrontmatterString(parsed, "string")).toBe("value");
        expect(boundedFrontmatterString(parsed, "number")).toBeUndefined();
        expect(boundedFrontmatterBoolean(parsed, "boolean")).toBe(true);
        expect(boundedFrontmatterBoolean(parsed, "string")).toBeUndefined();
        expect(boundedFrontmatterFiniteNumber(parsed, "number")).toBe(2);
        expect(boundedFrontmatterFiniteNumber(parsed, "string")).toBeUndefined();
        expect(
            boundedFrontmatterFiniteNumber({ ...parsed, values: { number: Number.POSITIVE_INFINITY } }, "number"),
        ).toBeUndefined();
        expect(boundedFrontmatterStringList(parsed, "listText")).toEqual(["Read", "Bash(git diff, --stat)"]);
        expect(boundedFrontmatterStringList(parsed, "flatListText", false)).toEqual(["one(two", "three)", "four"]);
        expect(boundedFrontmatterStringList(parsed, "list")).toEqual(["Read", "Write"]);
        expect(boundedFrontmatterStringList(parsed, "mixedList")).toBeUndefined();
        expect(boundedFrontmatterStringList(parsed, "nullValue")).toBeUndefined();
        expect(boundedFrontmatterStringMap(parsed, "stringMap")).toEqual({ owner: "oaam" });
        expect(boundedFrontmatterStringMap(parsed, "nullValue")).toBeUndefined();
        expect(boundedFrontmatterStringMap(parsed, "list")).toBeUndefined();
        expect(boundedFrontmatterStringMap(parsed, "mixedMap")).toBeUndefined();
        expect(boundedFrontmatterScalarMap(parsed, "scalarMap")).toEqual({
            enabled: true,
            count: 2,
            name: "oaam",
        });
        expect(boundedFrontmatterScalarMap(parsed, "nullValue")).toBeUndefined();
        expect(boundedFrontmatterScalarMap(parsed, "list")).toBeUndefined();
    });
});
