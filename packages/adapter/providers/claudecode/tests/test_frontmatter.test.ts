import { describe, expect, it } from "vitest";
import {
    containsExecutablePromptSubstitution,
    frontmatterBoolean,
    frontmatterNumber,
    frontmatterString,
    frontmatterStringMap,
    frontmatterStrings,
    parseClaudeFrontmatter,
    splitDelimited,
} from "../src/claudecode-frontmatter";

describe("Claude frontmatter parser", () => {
    it("parses the bounded scalar, list, and string-map subset without executing YAML", () => {
        const parsed = parseClaudeFrontmatter(
            `---\nname: "review"\nenabled: true\nturns: 4\ntools: [Read, "Bash(git diff, --stat)"]\nmetadata:\n  type: project\n  originSessionId: abc\n---\nBody\n`,
        );
        expect(parsed).toMatchObject({ hasFrontmatter: true, closed: true, body: "Body\n" });
        expect(frontmatterString(parsed, "name")).toBe("review");
        expect(frontmatterBoolean(parsed, "enabled")).toBe(true);
        expect(frontmatterNumber(parsed, "turns")).toBe(4);
        expect(frontmatterStrings(parsed, "tools")).toEqual(["Read", "Bash(git diff, --stat)"]);
        expect(frontmatterStringMap(parsed, "metadata")).toEqual({
            type: "project",
            originSessionId: "abc",
        });
    });

    it("parses block lists and quoted comments while reporting malformed combinations", () => {
        const parsed = parseClaudeFrontmatter(
            `---\nname: 'a # b' # comment\ntools:\n  - Read\n  - 'Bash(git status)'\nmixed:\n  - one\n  key: two\nduplicate: one\nduplicate: two\norphan line\n---\ntext`,
        );
        expect(frontmatterString(parsed, "name")).toBe("a # b");
        expect(frontmatterStrings(parsed, "tools")).toEqual(["Read", "Bash(git status)"]);
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining("mixed list/map"),
                expect.stringContaining("duplicate"),
                expect.stringContaining("unsupported frontmatter line"),
            ]),
        );
    });

    it("keeps plain and unclosed documents intact instead of guessing metadata", () => {
        expect(parseClaudeFrontmatter("plain")).toMatchObject({
            hasFrontmatter: false,
            closed: false,
            body: "plain",
        });
        expect(parseClaudeFrontmatter("---\nname: x\nbody")).toMatchObject({
            hasFrontmatter: true,
            closed: false,
            body: "---\nname: x\nbody",
            diagnostics: ["frontmatter is not closed"],
        });
    });

    it("does not coerce unsupported YAML and type-mismatched accessors", () => {
        const parsed = parseClaudeFrontmatter(`---\nblock: |\nempty: null\nnumber: 2\nflag: false\nrecord: {}\n---\n`);
        expect(parsed.diagnostics).toContain("unsupported value for frontmatter key block");
        expect(frontmatterString(parsed, "number")).toBeUndefined();
        expect(frontmatterBoolean(parsed, "number")).toBeUndefined();
        expect(frontmatterNumber(parsed, "flag")).toBeUndefined();
        expect(frontmatterStrings(parsed, "record")).toBeUndefined();
        expect(frontmatterStringMap(parsed, "empty")).toBeUndefined();
    });

    it("splits complex selectors only at top-level commas", () => {
        expect(splitDelimited(`Read, Bash(git diff, --stat), "Agent(a,b)", 'Write'`)).toEqual([
            "Read",
            "Bash(git diff, --stat)",
            "Agent(a,b)",
            "Write",
        ]);
    });

    it("detects only Claude executable prompt substitution forms", () => {
        expect(containsExecutablePromptSubstitution("Run !`git status` now")).toBe(true);
        expect(containsExecutablePromptSubstitution("```!\ngit status\n```")).toBe(true);
        expect(containsExecutablePromptSubstitution("literal x!`not-command` text")).toBe(false);
        expect(containsExecutablePromptSubstitution("```\n!`inside markdown fence`\n```")).toBe(true);
        expect(containsExecutablePromptSubstitution("no substitution")).toBe(false);
    });

    it("reports each unsupported nested container shape without inventing values", () => {
        const parsed = parseClaudeFrontmatter(
            `---\n# comment\n\n: empty-key\norphan: value\n  nested-without-container: value\ninvalid-list:\n  -\nrecord:\n  key: value\n  key: duplicate\n  - list-after-map\nlist:\n  - one\n  key: map-after-list\nnonstring-map:\n  enabled: true\nunsupported-list:\n  - |\n---\nbody`,
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining("unsupported frontmatter line"),
                expect.stringContaining("orphan nested"),
                expect.stringContaining("invalid list item"),
                expect.stringContaining("duplicate map key"),
                expect.stringContaining("mixed list/map"),
                expect.stringContaining("non-string map value"),
                expect.stringContaining("unsupported list item"),
            ]),
        );
    });

    it("covers scalar/list accessor fallbacks and escaped quoted values", () => {
        const parsed = parseClaudeFrontmatter(
            `---\nstrings: Read, Write,\nmixed: [Read, 2, true]\nsingle: 'it''s fine'\nescaped: "a\\"b"\nbroken: "unterminated\nempty: []\ncommented: value # trailing\n---\r\nbody\r\n`,
        );
        expect(frontmatterStrings(parsed, "strings")).toEqual(["Read", "Write"]);
        expect(frontmatterStrings(parsed, "mixed")).toBeUndefined();
        expect(frontmatterString(parsed, "single")).toBe("it's fine");
        expect(frontmatterString(parsed, "escaped")).toBe('a"b');
        expect(frontmatterString(parsed, "broken")).toBe('"unterminated');
        expect(parsed.diagnostics).toContain("unsupported value for frontmatter key broken");
        expect(frontmatterStrings(parsed, "empty")).toEqual([]);
        expect(frontmatterString(parsed, "commented")).toBe("value");
    });

    it("handles empty selector items, escaped quotes, and unmatched delimiters deterministically", () => {
        expect(splitDelimited(`, "a\\"b", nested(one,two), [x,y], trailing,`)).toEqual([
            'a"b',
            "nested(one,two)",
            "[x,y]",
            "trailing",
        ]);
        expect(containsExecutablePromptSubstitution("!`closed`")).toBe(true);
        expect(containsExecutablePromptSubstitution("!`unclosed")).toBe(false);
        expect(containsExecutablePromptSubstitution("```!\n``` and ```!missing")).toBe(false);
    });

    it("handles an invalid nested key, comment-only scalar, and full CRLF input", () => {
        const parsed = parseClaudeFrontmatter("---\r\ncontainer:\r\n  : invalid\r\ncommentOnly: # removed\r\n---\r\nbody\r\n");
        expect(parsed.body).toBe("body\r\n");
        expect(parsed.diagnostics).toContain("unsupported nested value for container");
        expect(frontmatterString(parsed, "commentOnly")).toBe("");
    });

    it("rejects tab indentation and invalid double-quoted escapes instead of guessing YAML", () => {
        const parsed = parseClaudeFrontmatter('---\nmetadata:\n\ttype: project\nname: "bad\\q"\n---\nbody\n');
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining("unsupported tab indentation"),
                "unsupported value for frontmatter key name",
            ]),
        );
        expect(frontmatterStringMap(parsed, "metadata")).toBeUndefined();
        expect(frontmatterString(parsed, "name")).toBe('"bad\\q"');
    });

    it("rejects prototype-mutating keys at both frontmatter levels", () => {
        const parsed = parseClaudeFrontmatter(
            "---\nconstructor: unsafe\nmetadata:\n  owner: oaam\n  __proto__: polluted\n---\nBody\n",
        );
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining(["unsafe frontmatter key constructor", "unsafe map key metadata.__proto__"]),
        );
        expect(Object.hasOwn(parsed.values, "constructor")).toBe(false);
        expect(frontmatterStringMap(parsed, "metadata")).toEqual({ owner: "oaam" });
        expect(Object.getPrototypeOf(parsed.values)).toBe(Object.prototype);
    });
});
