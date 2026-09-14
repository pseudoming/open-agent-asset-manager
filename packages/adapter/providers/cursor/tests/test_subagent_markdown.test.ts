import type { AssetKindTypeDataV2 } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    CURSOR_SUBAGENT_MODEL_DIALECT,
    CURSOR_SUBAGENT_PERMISSION_DIALECT,
    CURSOR_SUBAGENT_TOOL_DIALECT,
    parseCursorMarkdownSubagent,
    projectCursorMarkdownSubagentCanonical,
    rebaseCursorMarkdownSubagent,
    reverseCursorMarkdownSubagent,
    serializeCursorMarkdownSubagent,
} from "../src/cursor-subagent-markdown";

const BODY = "Review the isolated project and report OAAM_CURSOR_SUBAGENT_CURRENT.\n";
const REBASED_BODY = BODY.replace("CURRENT", "REBASED");
const NATIVE = markdown(
    [
        "# preserve Cursor-native layout",
        'name: "oaam-reviewer"',
        'description: "Review the isolated project"',
        'tools: "Read, Grep"',
        'model: "fast"',
        "readonly: true",
        "is_background: false",
        "force-default-model: false",
    ],
    BODY,
);

describe("Cursor current Markdown Subagent dialect", () => {
    it("projects every accepted behavior-bearing field and serializes safe portable syntax", () => {
        const projection = required(projectCursorMarkdownSubagentCanonical(canonical(), instruction(BODY)));
        expect(projection).toMatchObject({
            name: "oaam-reviewer",
            description: "Review the isolated project",
            body: BODY,
            tools: ["Read", "Grep"],
            model: "fast",
            readonly: true,
            background: false,
        });
        const serialized = serializeCursorMarkdownSubagent(projection);
        expect(serialized).toContain('tools: "Read, Grep"');
        expect(serialized).toContain('model: "fast"');
        expect(serialized).toContain("readonly: true");
        expect(serialized).toContain("background: false");
        expect(serialized.endsWith(BODY)).toBe(true);
    });

    it("parses exact aliases, no-op private syntax, and the canonical field mapping", () => {
        const parsed = parseCursorMarkdownSubagent(NATIVE, ".cursor/agents/reviewer.md");
        expect(parsed).toMatchObject({
            disposition: "candidate",
            name: "oaam-reviewer",
            description: "Review the isolated project",
            typeData: {
                tools: { availability: { base: { mode: "allowlist" } } },
                execution: {
                    permission: { mode: "selected", effect: "read_only" },
                    scheduling: { mode: "always_foreground" },
                    model: { mode: "selected", selector: "fast", relativeTier: -1 },
                },
            },
            projection: { backgroundKey: "is_background" },
            diagnostics: [],
        });
    });

    it("preserves comments, no-op fields and legacy aliases while rebasing portable behavior", () => {
        const changed = canonical();
        changed.typeData.name = "oaam-auditor";
        changed.typeData.description = "Audit the isolated project";
        changed.typeData.tools.availability.base = { mode: "inherit_available" };
        changed.typeData.execution.model = { mode: "inherit" };
        changed.typeData.execution.permission = { mode: "inherit" };
        changed.typeData.execution.scheduling = { mode: "always_background" };
        const projection = required(projectCursorMarkdownSubagentCanonical(changed, instruction(REBASED_BODY)));
        const rebased = required(rebaseCursorMarkdownSubagent(NATIVE, projection));
        expect(rebased).toContain("# preserve Cursor-native layout");
        expect(rebased).toContain('name: "oaam-auditor"');
        expect(rebased).toContain('description: "Audit the isolated project"');
        expect(rebased).not.toContain("tools:");
        expect(rebased).not.toContain("\nmodel:");
        expect(rebased).not.toContain("readonly:");
        expect(rebased).toContain("is_background: true");
        expect(rebased).toContain("force-default-model: false");
        expect(rebased.endsWith(REBASED_BODY)).toBe(true);
    });

    it("keeps explicit no-op scalar forms when their portable semantics did not change", () => {
        const minimal = markdown(
            ["name: minimal", "description: Minimal", 'tools: ""', "model: inherit", "readonly: false", "background: false"],
            BODY,
        );
        const parsed = parseCursorMarkdownSubagent(minimal, ".cursor/agents/minimal.md");
        if (parsed.disposition !== "candidate") throw new Error("Cursor minimal Subagent did not parse");
        const projection = required(
            projectCursorMarkdownSubagentCanonical(
                { kind: "Subagent", typeData: parsed.typeData },
                JSON.stringify(parsed.instruction),
            ),
        );
        expect(rebaseCursorMarkdownSubagent(minimal, projection)).toBe(minimal);
    });

    it("adds omitted portable fields without disturbing the existing native envelope", () => {
        const minimal = markdown(["name: oaam-reviewer", "description: Review the isolated project"], BODY);
        const rebased = required(
            rebaseCursorMarkdownSubagent(
                minimal,
                required(projectCursorMarkdownSubagentCanonical(canonical(), instruction(BODY))),
            ),
        );
        expect(rebased).toContain('tools: "Read, Grep"');
        expect(rebased).toContain('model: "fast"');
        expect(rebased).toContain("readonly: true");
        expect(rebased).toContain("background: false");
    });

    it("reverse-accepts only prompt-body changes", () => {
        expect(reverseCursorMarkdownSubagent(NATIVE, NATIVE.replace(BODY, REBASED_BODY))).toBe(instruction(REBASED_BODY));
        expect(reverseCursorMarkdownSubagent(NATIVE, NATIVE.replace('model: "fast"', 'model: "slow"'))).toBeNull();
        expect(reverseCursorMarkdownSubagent("not frontmatter", NATIVE)).toBeNull();
        expect(reverseCursorMarkdownSubagent(NATIVE, "not frontmatter")).toBeNull();
        expect(reverseCursorMarkdownSubagent(NATIVE, NATIVE.replace(BODY, "   \n"))).toBeNull();
    });

    it("rejects unknown behavior, ambiguous aliases and force-default model semantics", () => {
        for (const [extra, code] of [
            ["futureBehavior: true", "cursor.subagent_frontmatter_semantics_unsupported"],
            ["background: true\nis_background: false", "cursor.subagent_background_alias_ambiguous"],
            ["force-default-model: true", "cursor.subagent_force_default_model_unmapped"],
        ] as const) {
            const parsed = parseCursorMarkdownSubagent(
                markdown(["name: test", "description: Test", extra], BODY),
                ".cursor/agents/test.md",
            );
            expect(parsed).toMatchObject({
                disposition: "candidate",
                diagnostics: expect.arrayContaining([expect.objectContaining({ code, severity: "error" })]),
            });
        }
    });

    it("rejects missing and invalid scalar fields without inventing defaults", () => {
        for (const source of [
            "No frontmatter\n",
            "---\nname: missing-close\ndescription: Missing close\n",
            markdown(["description: Missing name"], BODY),
            markdown(["name: missing-description"], BODY),
            markdown(["name: empty", "description: Empty"], "  \n"),
        ]) {
            expect(parseCursorMarkdownSubagent(source, ".cursor/agents/invalid.md").disposition).toBe("ignored");
        }
        const newlineTool = parseCursorMarkdownSubagent(
            markdown(["name: invalid", "description: Invalid", 'tools: "Read\\nBad"'], BODY),
            ".cursor/agents/invalid.md",
        );
        expect(newlineTool).toMatchObject({
            disposition: "candidate",
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: "cursor.subagent_tools_invalid" })]),
        });
        for (const field of ["tools: [Read]", "model: [fast]", "readonly: maybe", "background: maybe"]) {
            const parsed = parseCursorMarkdownSubagent(
                markdown(["name: invalid", "description: Invalid", field], BODY),
                ".cursor/agents/invalid.md",
            );
            expect(parsed).toMatchObject({
                disposition: "candidate",
                diagnostics: expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
            });
        }
    });

    it("blocks every portable behavior Cursor cannot represent", () => {
        const cases: Array<(value: ReturnType<typeof canonical>) => void> = [
            (value) => {
                value.typeData.promptContextPolicy = { mode: "selected", dialectId: "foreign", selectors: ["x"] };
            },
            (value) => {
                value.typeData.tools.availability.unavailable = [{ mode: "portable_tool", tool: "write_file" }];
            },
            (value) => {
                value.typeData.tools.availability.base = {
                    mode: "allowlist",
                    allowed: [{ mode: "portable_tool", tool: "read_file" }],
                };
            },
            (value) => {
                value.typeData.tools.permission.otherwise = "deny";
            },
            (value) => {
                value.typeData.dependencies.preloadedSkillVersionIds = ["11111111-1111-4111-8111-111111111111"];
            },
            (value) => {
                value.typeData.memory = { mode: "session_only" };
            },
            (value) => {
                value.typeData.execution.workspaceIsolation = { mode: "isolated_worktree" };
            },
            (value) => {
                value.typeData.execution.turnLimit = { mode: "bounded", dialectId: "foreign", limit: 2 };
            },
            (value) => {
                value.typeData.execution.model = { mode: "selected", dialectId: "foreign", selector: "fast", relativeTier: -1 };
            },
            (value) => {
                value.typeData.execution.permission = {
                    mode: "selected",
                    dialectId: "foreign",
                    selector: "readonly",
                    effect: "read_only",
                };
            },
            (value) => {
                value.typeData.execution.scheduling = { mode: "runtime_decides" };
            },
            (value) => {
                value.typeData.execution.effort = { mode: "selected", level: "high" };
            },
            (value) => {
                value.typeData.directInvocation = { mode: "user_selectable", initialPrompt: { mode: "none" } };
            },
            (value) => {
                value.typeData.presentation.listing = "hidden";
            },
            (value) => {
                value.typeData.presentation.color = { mode: "selected", dialectId: "foreign", selector: "red" };
            },
        ];
        for (const mutate of cases) {
            const value = canonical();
            mutate(value);
            expect(projectCursorMarkdownSubagentCanonical(value, instruction(BODY))).toBeNull();
        }
        for (const entry of [
            "not json",
            "[]",
            JSON.stringify({ schemaVersion: 2, sections: [{ title: "", content: BODY }] }),
            JSON.stringify({ schemaVersion: 1, sections: [] }),
            JSON.stringify({ schemaVersion: 1, sections: [{ title: "wrong", content: BODY }] }),
        ]) {
            expect(projectCursorMarkdownSubagentCanonical(canonical(), entry)).toBeNull();
        }
    });

    it("fails parent rebase when comments would be destroyed", () => {
        const parent = markdown(["name: test", "description: Test", 'tools: "Read" # keep rationale'], BODY);
        const changed = canonical();
        changed.typeData.name = "test";
        changed.typeData.description = "Test";
        changed.typeData.tools.availability.base = { mode: "inherit_available" };
        const projection = required(projectCursorMarkdownSubagentCanonical(changed, instruction(BODY)));
        expect(rebaseCursorMarkdownSubagent(parent, projection)).toBeNull();
    });
});

function canonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: "oaam-reviewer",
            description: "Review the isolated project",
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base: { mode: "allowlist", allowed: [runtimeTool("Read"), runtimeTool("Grep")] },
                    unavailable: [],
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: {
                    mode: "selected",
                    dialectId: CURSOR_SUBAGENT_PERMISSION_DIALECT,
                    selector: "readonly",
                    effect: "read_only",
                },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "always_foreground" },
                turnLimit: { mode: "agent_runtime_default" },
                model: { mode: "selected", dialectId: CURSOR_SUBAGENT_MODEL_DIALECT, selector: "fast", relativeTier: -1 },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: { listing: "visible", color: { mode: "agent_runtime_default" } },
        },
    };
}

function runtimeTool(selector: string) {
    return { mode: "agent_runtime_tool" as const, selector: { dialectId: CURSOR_SUBAGENT_TOOL_DIALECT, selector } };
}

function markdown(fields: string[], body: string): string {
    return `---\n${fields.join("\n")}\n---\n${body}`;
}

function instruction(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("required Cursor Subagent fixture missing");
    return value;
}
