import type { AssetKindTypeDataV2 } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    projectZcodeMarkdownSubagentCanonical,
    rebaseZcodeMarkdownSubagent,
    reverseZcodeMarkdownSubagent,
    serializeZcodeMarkdownSubagent,
} from "../src/zcode-subagent-markdown";
import {
    ZCODE_COLOR_DIALECT,
    ZCODE_MODEL_DIALECT,
    ZCODE_PERMISSION_DIALECT,
    ZCODE_SUBAGENT_TOOL_DIALECT,
    ZCODE_TURN_LIMIT_DIALECT,
} from "../src/zcode-source-read-fields";

const BODY = "Review the isolated project and report OAAM_ZCODE_SUBAGENT_CURRENT.\n";
const REBASED_BODY = BODY.replace("CURRENT", "REBASED");
const NATIVE = markdown(
    [
        "# preserve ZCode native layout",
        'name: "oaam-reviewer"',
        'description: "Review the isolated project"',
        'tools: ["Read", "Grep"]',
        'disallowedTools: ["Write"]',
        'model: "glm-5"',
        "permissionMode: plan",
        "maxTurns: 7",
        "background: false",
        "color: blue",
    ],
    BODY,
);

describe("ZCode current Markdown Subagent dialect", () => {
    it.each(["project", "global"] as const)("projects every exact %s behavior-bearing field", (scope) => {
        const value = subagentCanonical(scope === "global");
        const projection = projectZcodeMarkdownSubagentCanonical(value, instruction(BODY), scope);
        expect(projection).toEqual({
            name: "oaam-reviewer",
            description: "Review the isolated project",
            body: BODY,
            tools: ["Read", "Grep"],
            disallowedTools: ["Write"],
            model: "glm-5",
            permissionMode: scope === "global" ? "plan" : undefined,
            maxTurns: 7,
            background: false,
            color: "blue",
        });
        const serialized = serializeZcodeMarkdownSubagent(required(projection));
        expect(serialized).toContain('tools: ["Read","Grep"]');
        expect(serialized).toContain('disallowedTools: ["Write"]');
        expect(serialized).toContain("maxTurns: 7");
        expect(serialized).toContain("background: false");
        expect(serialized).toContain("color: blue");
        expect(serialized.includes("permissionMode: plan")).toBe(scope === "global");
    });

    it("preserves project permissionMode and native comments while rebasing fields ZCode actually consumes", () => {
        const changed = subagentCanonical(false);
        changed.typeData.name = "oaam-auditor";
        changed.typeData.description = "Audit the isolated project";
        changed.typeData.tools.availability.base = { mode: "inherit_available" };
        changed.typeData.tools.availability.unavailable = [];
        changed.typeData.execution.model = { mode: "inherit" };
        changed.typeData.execution.turnLimit = { mode: "agent_runtime_default" };
        changed.typeData.execution.scheduling = { mode: "always_background" };
        changed.typeData.presentation.color = { mode: "agent_runtime_default" };
        const projection = required(projectZcodeMarkdownSubagentCanonical(changed, instruction(REBASED_BODY), "project"));
        const rebased = required(rebaseZcodeMarkdownSubagent(NATIVE, projection, "project"));
        expect(rebased).toContain("# preserve ZCode native layout");
        expect(rebased).toContain('name: "oaam-auditor"');
        expect(rebased).toContain('description: "Audit the isolated project"');
        expect(rebased).not.toContain("tools:");
        expect(rebased).toContain("disallowedTools: []");
        expect(rebased).not.toContain("model:");
        expect(rebased).not.toContain("maxTurns:");
        expect(rebased).toContain("permissionMode: plan");
        expect(rebased).toContain("background: true");
        expect(rebased).not.toContain("color:");
        expect(rebased.endsWith(REBASED_BODY)).toBe(true);
    });

    it("edits global permissionMode and can add omitted safe fields", () => {
        const minimal = markdown(['name: "minimal"', 'description: "Minimal"'], BODY);
        const changed = subagentCanonical(true);
        changed.typeData.name = "minimal";
        changed.typeData.description = "Minimal";
        changed.typeData.execution.permission = {
            mode: "selected",
            dialectId: ZCODE_PERMISSION_DIALECT,
            selector: "dontAsk",
            effect: "auto_deny_unapproved",
        };
        const projection = required(projectZcodeMarkdownSubagentCanonical(changed, instruction(BODY), "global"));
        const rebased = required(rebaseZcodeMarkdownSubagent(minimal, projection, "global"));
        expect(rebased).toContain('tools: ["Read","Grep"]');
        expect(rebased).toContain('disallowedTools: ["Write"]');
        expect(rebased).toContain('model: "glm-5"');
        expect(rebased).toContain('permissionMode: "dontAsk"');
        expect(rebased).toContain("maxTurns: 7");
        expect(rebased).toContain("background: false");
        expect(rebased).toContain('color: "blue"');
    });

    it("rewrites an uncommented multiline list and blocks deleting commented native fields", () => {
        const multiline = markdown(
            ['name: "oaam-reviewer"', 'description: "Review the isolated project"', "tools:", "  - Read", "  - Grep"],
            BODY,
        );
        const inherited = subagentCanonical(false);
        inherited.typeData.tools.availability.base = { mode: "inherit_available" };
        inherited.typeData.tools.availability.unavailable = [];
        inherited.typeData.execution.model = { mode: "inherit" };
        inherited.typeData.execution.turnLimit = { mode: "agent_runtime_default" };
        inherited.typeData.execution.scheduling = { mode: "agent_runtime_default" };
        inherited.typeData.presentation.color = { mode: "agent_runtime_default" };
        const projection = required(projectZcodeMarkdownSubagentCanonical(inherited, instruction(BODY), "project"));
        expect(rebaseZcodeMarkdownSubagent(multiline, projection, "project")).not.toContain("tools:");
        const commented = multiline.replace("  - Grep", "  # preserve tool rationale\n  - Grep");
        expect(rebaseZcodeMarkdownSubagent(commented, projection, "project")).toBeNull();
    });

    it("reverse-accepts only a prompt-body change", () => {
        expect(reverseZcodeMarkdownSubagent(NATIVE, NATIVE.replace(BODY, REBASED_BODY))).toBe(instruction(REBASED_BODY.trim()));
        expect(reverseZcodeMarkdownSubagent(NATIVE, NATIVE.replace("color: blue", "color: green"))).toBeNull();
        expect(reverseZcodeMarkdownSubagent("not frontmatter", NATIVE)).toBeNull();
        expect(reverseZcodeMarkdownSubagent(NATIVE, "not frontmatter")).toBeNull();
        expect(reverseZcodeMarkdownSubagent(NATIVE, NATIVE.replace(BODY, "   \n"))).toBeNull();
    });

    it("blocks every unrepresentable canonical behavior instead of silently degrading it", () => {
        const cases: Array<(value: ReturnType<typeof subagentCanonical>) => void> = [
            (value) => {
                value.typeData.promptContextPolicy = { mode: "selected", dialectId: "foreign", selectors: ["context"] };
            },
            (value) => {
                value.typeData.tools.availability.base = { mode: "none" };
            },
            (value) => {
                value.typeData.tools.availability.base = {
                    mode: "allowlist",
                    allowed: [{ mode: "portable_tool", tool: "read_file" }],
                };
            },
            (value) => {
                value.typeData.tools.availability.unavailable = ["shell"];
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
                value.typeData.execution.scheduling = { mode: "runtime_decides" };
            },
            (value) => {
                value.typeData.execution.turnLimit = { mode: "bounded", dialectId: "foreign", limit: 2 };
            },
            (value) => {
                value.typeData.execution.model = {
                    mode: "selected",
                    dialectId: "foreign",
                    selector: "glm-5",
                    relativeTier: -1,
                };
            },
            (value) => {
                value.typeData.execution.permission = {
                    mode: "selected",
                    dialectId: "foreign",
                    selector: "plan",
                    effect: "read_only",
                };
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
                value.typeData.presentation.color = { mode: "selected", dialectId: "foreign", selector: "blue" };
            },
        ];
        for (const mutate of cases) {
            const value = subagentCanonical(true);
            mutate(value);
            expect(projectZcodeMarkdownSubagentCanonical(value, instruction(BODY), "global")).toBeNull();
        }
        const projectPermission = subagentCanonical(true);
        expect(projectZcodeMarkdownSubagentCanonical(projectPermission, instruction(BODY), "project")).toBeNull();
    });

    it("rejects malformed entry JSON and scalars the exact parser cannot round-trip", () => {
        const value = subagentCanonical(true);
        for (const entry of [
            "not json",
            "[]",
            JSON.stringify({ schemaVersion: 2, sections: [{ title: "", content: BODY }] }),
            JSON.stringify({ schemaVersion: 1, sections: [] }),
            JSON.stringify({ schemaVersion: 1, sections: [{ title: "wrong", content: BODY }] }),
        ]) {
            expect(projectZcodeMarkdownSubagentCanonical(value, entry, "global")).toBeNull();
        }
        value.typeData.name = 'unsafe"name';
        expect(projectZcodeMarkdownSubagentCanonical(value, instruction(BODY), "global")).toBeNull();
        value.typeData.name = "safe";
        value.typeData.description = "unsafe\\description";
        expect(projectZcodeMarkdownSubagentCanonical(value, instruction(BODY), "global")).toBeNull();
    });

    it("fails parent rebase for incomplete, unknown, or type-invalid native declarations", () => {
        const projection = required(projectZcodeMarkdownSubagentCanonical(subagentCanonical(true), instruction(BODY), "global"));
        for (const fields of [
            ['description: "Missing name"'],
            ['name: "missing-description"'],
            ['name: "unknown"', 'description: "Unknown"', "futureBehavior: true"],
            ['name: "tools"', 'description: "Tools"', "tools: 7"],
            ['name: "model"', 'description: "Model"', "model: [glm-5]"],
            ['name: "background"', 'description: "Background"', "background: maybe"],
            ['name: "color"', 'description: "Color"', "color: 7"],
        ]) {
            expect(rebaseZcodeMarkdownSubagent(markdown(fields, BODY), projection, "global")).toBeNull();
        }

        const scalarLists = markdown(
            [
                'name: "oaam-reviewer"',
                'description: "Review the isolated project"',
                "tools: Read, Grep",
                "disallowedTools: Write",
                "model: glm-5",
                "permissionMode: plan",
                "maxTurns: 7",
                "background: false",
                "color: blue",
            ],
            BODY,
        );
        expect(rebaseZcodeMarkdownSubagent(scalarLists, projection, "global")).not.toBeNull();
    });
});

function subagentCanonical(globalPermission: boolean): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: "oaam-reviewer",
            description: "Review the isolated project",
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base: {
                        mode: "allowlist",
                        allowed: [runtimeTool("Read"), runtimeTool("Grep")],
                    },
                    unavailable: [runtimeTool("Write")],
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: globalPermission
                    ? {
                          mode: "selected",
                          dialectId: ZCODE_PERMISSION_DIALECT,
                          selector: "plan",
                          effect: "read_only",
                      }
                    : { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "always_foreground" },
                turnLimit: { mode: "bounded", dialectId: ZCODE_TURN_LIMIT_DIALECT, limit: 7 },
                model: { mode: "selected", dialectId: ZCODE_MODEL_DIALECT, selector: "glm-5", relativeTier: -1 },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: {
                listing: "visible",
                color: { mode: "selected", dialectId: ZCODE_COLOR_DIALECT, selector: "blue" },
            },
        },
    };
}

function runtimeTool(selector: string) {
    return { mode: "agent_runtime_tool" as const, selector: { dialectId: ZCODE_SUBAGENT_TOOL_DIALECT, selector } };
}

function markdown(fields: readonly string[], body: string): string {
    return `---\n${fields.join("\n")}\n---\n${body}`;
}

function instruction(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function required<T>(value: T | null): T {
    if (value === null) throw new Error("expected ZCode Subagent projection");
    return value;
}
