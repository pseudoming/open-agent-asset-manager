import { describe, expect, it } from "vitest";
import {
    colorSelection,
    commandArgumentNames,
    commandCommaList,
    containsUnsupportedShellExpansion,
    fallbackDescription,
    modelSelection,
    optionalBoolean,
    optionalString,
    permissionPolicy,
    positiveTurnLimit,
    stringList,
    subagentToolSelectors,
    workflowToolSelectors,
} from "../src/zcode-source-read-fields";
import { parseZcodeCommandFrontmatter, parseZcodeFrontmatter, parseZcodeSubagentFrontmatter } from "../src/zcode-frontmatter";

function parsed(source: string) {
    return parseZcodeFrontmatter(`---\n${source}\n---\nBody\n`);
}

describe("ZCode source field projection", () => {
    it("distinguishes absent, exact, and malformed scalar fields", () => {
        const diagnostics: Parameters<typeof optionalString>[2] = [];
        const values = parsed('name: demo\nflag: true\nwrongName: 7\nwrongFlag: "yes"');
        expect(optionalString(values, "absent", diagnostics, "fixture", "Workflow")).toBeUndefined();
        expect(optionalString(values, "name", diagnostics, "fixture", "Workflow")).toBe("demo");
        expect(optionalString(values, "wrongName", diagnostics, "fixture", "Workflow")).toBeUndefined();
        expect(optionalBoolean(values, "absent", diagnostics, "fixture", "Subagent")).toBeUndefined();
        expect(optionalBoolean(values, "flag", diagnostics, "fixture", "Subagent")).toBe(true);
        expect(optionalBoolean(values, "wrongFlag", diagnostics, "fixture", "Subagent")).toBeUndefined();
        expect(
            optionalBoolean(
                parseZcodeCommandFrontmatter("---\nflag: yes\n---\nBody\n"),
                "flag",
                diagnostics,
                "fixture",
                "Workflow",
            ),
        ).toBe(true);
        expect(diagnostics).toEqual([
            expect.objectContaining({ code: "zcode.workflow_wrongname_invalid", severity: "warning" }),
            expect.objectContaining({ code: "zcode.subagent_wrongflag_invalid", severity: "warning" }),
        ]);
    });

    it("mirrors the current flat custom-command frontmatter grammar without treating indented YAML as authority", () => {
        const command = parseZcodeCommandFrontmatter(
            '\ufeff---\ndescription: "Demo"\nallowed-tools: [Read, "Bash(git status)"]\n  - Write\ndescription: Replacement\nconstructor: unsafe\ninvalid\n---\nBody\n',
        );
        expect(command).toMatchObject({
            hasFrontmatter: true,
            closed: true,
            body: "Body\n",
            values: {
                description: "Replacement",
                "allowed-tools": '[Read, "Bash(git status)"]',
            },
        });
        expect(command.presentKeys).toEqual(["allowed-tools", "description"]);
        expect(command.diagnostics).toEqual([
            "duplicate frontmatter key description",
            "unsafe frontmatter key constructor",
            "unsupported frontmatter line 7",
        ]);
        const diagnostics: Parameters<typeof commandCommaList>[2] = [];
        expect(commandCommaList(command, "allowed-tools", diagnostics, "fixture")).toEqual(["Read", '"Bash(git status)"']);
        expect(commandCommaList(command, "missing", diagnostics, "fixture")).toBeUndefined();
        const wrongType = parsed("allowed-tools: 7");
        expect(commandCommaList(wrongType, "allowed-tools", diagnostics, "fixture")).toEqual([]);
        expect(diagnostics).toContainEqual(
            expect.objectContaining({ code: "zcode.workflow_allowed-tools_invalid", severity: "error" }),
        );
        expect(parseZcodeCommandFrontmatter("No frontmatter\nBody")).toMatchObject({ hasFrontmatter: false });
        expect(parseZcodeCommandFrontmatter("---\nmissing close")).toMatchObject({ hasFrontmatter: true, closed: false });
    });

    it("mirrors the current loose Subagent grammar while failing closed on ambiguous keys", () => {
        const subagent = parseZcodeSubagentFrontmatter(
            "\ufeff---\r\n" +
                "name: demo\r\n" +
                "description: 'Line\\nOne' # comment\r\n" +
                "tools:\r\n" +
                "  # retained list context\r\n" +
                "  - Read\r\n" +
                "  - Bash(git diff, --stat)\r\n" +
                "  - [Nested, Value]\r\n" +
                "description: replacement\r\n" +
                "  indented: ignored\r\n" +
                "constructor: unsafe\r\n" +
                "invalid\r\n" +
                "---\r\nBody\r\n",
        );
        expect(subagent).toMatchObject({
            hasFrontmatter: true,
            closed: true,
            body: "Body\n",
            values: {
                name: "demo",
                description: "replacement",
                tools: ["Read", "Bash(git diff, --stat)", null],
            },
        });
        expect(subagent.presentKeys).toEqual(["description", "name", "tools"]);
        expect(subagent.diagnostics).toEqual([
            "unsupported nested list item for tools",
            "duplicate frontmatter key description",
            "unsupported frontmatter line 10",
            "unsafe frontmatter key constructor",
            "unsupported frontmatter line 12",
        ]);
        expect(parseZcodeSubagentFrontmatter("No frontmatter")).toMatchObject({ hasFrontmatter: false });
        expect(parseZcodeSubagentFrontmatter("---\nmissing close")).toMatchObject({ hasFrontmatter: true, closed: false });
    });

    it("projects runtime list syntax without splitting tool arguments", () => {
        const diagnostics: Parameters<typeof stringList>[2] = [];
        const values = parsed("tools: Read, Bash(git diff, --stat) Grep(pattern)\narray:\n  - Read\n  - Write\nbad: [Read, 7]");
        expect(stringList(values, "absent", diagnostics, "fixture", "Workflow")).toBeUndefined();
        expect(stringList(values, "tools", diagnostics, "fixture", "Workflow")).toEqual([
            "Read",
            "Bash(git diff, --stat)",
            "Grep(pattern)",
        ]);
        expect(stringList(values, "array", diagnostics, "fixture", "Subagent")).toEqual(["Read", "Write"]);
        expect(stringList(values, "bad", diagnostics, "fixture", "Subagent")).toEqual([]);
        expect(diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.subagent_bad_invalid", severity: "error" }));
        expect(workflowToolSelectors(["Read", " Bash(git diff) ", "Read", "()"])).toEqual([
            { dialectId: "zcode-command-tool-selector-v1", selector: "Read" },
            { dialectId: "zcode-command-tool-selector-v1", selector: "Bash(git diff)" },
            { dialectId: "zcode-command-tool-selector-v1", selector: "()" },
        ]);
        expect(subagentToolSelectors(["Read", "Grep(pattern)", "Bash(git diff)"])).toEqual([
            { dialectId: "zcode-subagent-tool-name-v1", selector: "Read" },
            { dialectId: "zcode-subagent-tool-name-v1", selector: "Grep" },
            { dialectId: "zcode-subagent-tool-name-v1", selector: "Bash" },
        ]);
        const command = parseZcodeCommandFrontmatter(
            "---\nallowed-tools: Read Bash(git status), Write\nskills: one two, three\n---\nBody\n",
        );
        expect(commandCommaList(command, "allowed-tools", diagnostics, "fixture")).toEqual(["Read Bash(git status)", "Write"]);
        expect(commandCommaList(command, "skills", diagnostics, "fixture")).toEqual(["one two", "three"]);
    });

    it("maps model, permission, turn, and color selectors conservatively", () => {
        expect(modelSelection(undefined)).toEqual({ mode: "inherit" });
        expect(modelSelection("inherit")).toEqual({ mode: "inherit" });
        expect(modelSelection("glm-5")).toEqual({
            mode: "selected",
            dialectId: "zcode-model-selector-v1",
            selector: "glm-5",
            relativeTier: -1,
        });

        const diagnostics: Parameters<typeof permissionPolicy>[1] = [];
        expect(permissionPolicy(undefined, diagnostics, "fixture")).toEqual({ mode: "inherit" });
        const effects = {
            acceptEdits: "auto_approve_selected_operations",
            auto: "classifier_mediated",
            bypassPermissions: "bypass_permission_checks",
            default: "interactive",
            dontAsk: "auto_deny_unapproved",
            plan: "read_only",
        } as const;
        for (const [selector, effect] of Object.entries(effects)) {
            expect(permissionPolicy(selector, diagnostics, "fixture")).toEqual({
                mode: "selected",
                dialectId: "zcode-permission-mode-v1",
                selector,
                effect,
            });
        }
        expect(permissionPolicy("future", diagnostics, "fixture")).toEqual({ mode: "inherit" });

        expect(positiveTurnLimit(parsed("name: demo"), diagnostics, "fixture")).toEqual({
            mode: "agent_runtime_default",
        });
        expect(positiveTurnLimit(parsed('maxTurns: "12"'), diagnostics, "fixture")).toEqual({
            mode: "bounded",
            dialectId: "zcode-max-turns-v1",
            limit: 12,
        });
        expect(positiveTurnLimit(parsed("maxTurns: 0"), diagnostics, "fixture")).toEqual({
            mode: "agent_runtime_default",
        });
        expect(positiveTurnLimit(parsed('maxTurns: "12x"'), diagnostics, "fixture")).toEqual({
            mode: "agent_runtime_default",
        });

        expect(colorSelection(undefined, diagnostics, "fixture")).toEqual({ mode: "agent_runtime_default" });
        expect(colorSelection("cyan", diagnostics, "fixture")).toEqual({
            mode: "selected",
            dialectId: "zcode-color-v1",
            selector: "cyan",
        });
        expect(colorSelection("ultraviolet", diagnostics, "fixture")).toEqual({ mode: "agent_runtime_default" });
        expect(diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "zcode.subagent_permission_ignored" }),
                expect.objectContaining({ code: "zcode.subagent_maxturns_invalid" }),
                expect.objectContaining({ code: "zcode.subagent_color_ignored" }),
            ]),
        );
    });

    it("extracts arguments, detects both rejected shell forms, and derives bounded descriptions", () => {
        expect(commandArgumentNames("Use $1, then $ARGUMENTS, then $1 and $20; ignore $name.")).toEqual(["1", "ARGUMENTS", "20"]);
        expect(containsUnsupportedShellExpansion("plain text")).toBe(false);
        expect(containsUnsupportedShellExpansion("run !`danger`")).toBe(true);
        expect(containsUnsupportedShellExpansion("```  !danger\n```")).toBe(true);
        expect(containsUnsupportedShellExpansion("```text\nsafe\n```")).toBe(false);
        expect(fallbackDescription("\n## Heading\nBody")).toBe("Heading");
        expect(fallbackDescription("\n- list item\nBody")).toBe("list item");
        expect(fallbackDescription("\n> quoted item\nBody")).toBe("> quoted item");
        expect(fallbackDescription("\n-list item\nBody")).toBe("list item");
        expect(fallbackDescription("\n\t\n")).toBe("");
        expect(fallbackDescription("x".repeat(1100))).toHaveLength(1024);
    });
});
