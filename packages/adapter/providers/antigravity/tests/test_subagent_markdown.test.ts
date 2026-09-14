import { describe, expect, it } from "vitest";
import type { AssetKindTypeDataV2 } from "@oaam/core";
import {
    ANTIGRAVITY_SUBAGENT_MODEL_DIALECT,
    ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT,
    ANTIGRAVITY_SUBAGENT_TOOL_DIALECT,
    parseAntigravityMarkdownSubagent,
    projectAntigravityMarkdownSubagentCanonical,
    rebaseAntigravityMarkdownSubagent,
    reverseAntigravityMarkdownSubagent,
    serializeAntigravityMarkdownSubagent,
} from "../src/antigravity-subagent-markdown";

const BODY = "Follow the project instructions and report OAAM_AGY_SUBAGENT_SOURCE.\n";
const NATIVE = markdown(
    [
        "# preserve this native comment",
        'name: "oaam-reviewer"',
        'description: "Review the isolated fixture"',
        "subagent: true",
        'tools: ["view_file", "run_command", "view_file"]',
        "mainAgent: false",
        "model: pro",
        "commandExecutionPolicy: sandbox",
        "hidden: false",
    ],
    BODY,
);

describe("Antigravity current Markdown Subagent dialect", () => {
    it("maps the official behavioral fields without losing their runtime selectors", () => {
        const parsed = parseCandidate(NATIVE);
        expect(parsed.diagnostics).toEqual([]);
        expect(parsed.instruction).toEqual({ schemaVersion: 1, sections: [{ title: "", content: BODY }] });
        expect(parsed.typeData).toMatchObject({
            name: "oaam-reviewer",
            description: "Review the isolated fixture",
            tools: {
                availability: {
                    base: {
                        mode: "allowlist",
                        allowed: [
                            {
                                mode: "agent_runtime_tool",
                                selector: { dialectId: ANTIGRAVITY_SUBAGENT_TOOL_DIALECT, selector: "view_file" },
                            },
                            {
                                mode: "agent_runtime_tool",
                                selector: { dialectId: ANTIGRAVITY_SUBAGENT_TOOL_DIALECT, selector: "run_command" },
                            },
                        ],
                    },
                },
            },
            execution: {
                model: {
                    mode: "selected",
                    dialectId: ANTIGRAVITY_SUBAGENT_MODEL_DIALECT,
                    selector: "pro",
                    relativeTier: 10,
                },
                permission: {
                    mode: "selected",
                    dialectId: ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT,
                    selector: "sandbox",
                    effect: "auto_approve_selected_operations",
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: { listing: "visible" },
        });
    });

    it.each([
        ["off", "interactive"],
        ["auto", "classifier_mediated"],
        ["eager", "auto_approve_selected_operations"],
        ["sandbox", "auto_approve_selected_operations"],
    ] as const)("retains the %s command policy selector separately from its portable effect", (selector, effect) => {
        const parsed = parseCandidate(
            markdown(["name: policy", "description: Policy", `commandExecutionPolicy: ${selector}`], BODY),
        );
        expect(parsed.typeData.execution.permission).toEqual({
            mode: "selected",
            dialectId: ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT,
            selector,
            effect,
        });
    });

    it("distinguishes omitted defaults, explicit empty tools, and direct/listing modes", () => {
        const inherited = parseCandidate(markdown(["name: inherited", "description: Inherited"], BODY));
        expect(inherited.typeData).toMatchObject({
            tools: { availability: { base: { mode: "inherit_available" } } },
            execution: { model: { mode: "inherit" }, permission: { mode: "inherit" } },
            directInvocation: { mode: "agent_runtime_default" },
            presentation: { listing: "agent_runtime_default" },
        });

        const explicit = parseCandidate(
            markdown(
                ["name: explicit", "description: Explicit", "tools: []", "mainAgent: true", "model: flash", "hidden: true"],
                BODY,
            ),
        );
        expect(explicit.typeData).toMatchObject({
            tools: { availability: { base: { mode: "none" } } },
            execution: {
                model: {
                    mode: "selected",
                    dialectId: ANTIGRAVITY_SUBAGENT_MODEL_DIALECT,
                    selector: "flash",
                    relativeTier: 1,
                },
            },
            directInvocation: { mode: "user_selectable", initialPrompt: { mode: "none" } },
            presentation: { listing: "hidden" },
        });
    });

    it.each([
        ["without frontmatter", "Body", "antigravity.subagent_markdown_frontmatter_missing"],
        [
            "without required content",
            markdown(["name: incomplete"], ""),
            "antigravity.subagent_markdown_required_content_missing",
        ],
        [
            "with MCP",
            markdown(["name: mcp", "description: MCP", 'mcpServers: ["local"]'], BODY),
            "antigravity.subagent_markdown_excluded_dependency",
        ],
        [
            "with plugin",
            markdown(["name: plugin", "description: Plugin", 'plugins: ["private"]'], BODY),
            "antigravity.subagent_markdown_excluded_dependency",
        ],
        [
            "inheriting MCP",
            markdown(["name: mcp", "description: MCP", "inheritMcp: true"], BODY),
            "antigravity.subagent_markdown_excluded_dependency",
        ],
        [
            "not delegation capable",
            markdown(["name: main", "description: Main", "subagent: false"], BODY),
            "antigravity.subagent_markdown_not_delegation_capable",
        ],
    ] as const)("rejects %s declarations as whole sources", (_label, text, code) => {
        const parsed = parseAntigravityMarkdownSubagent(text, ".agents/agents/rejected.md");
        expect(parsed.disposition).toBe("ignored");
        expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code }));
    });

    it("keeps malformed or dependency-bound declarations incomplete instead of guessing", () => {
        const parsed = parseCandidate(
            markdown(
                [
                    "name: uncertain",
                    "description: Uncertain",
                    "tools: [1]",
                    "mainAgent: maybe",
                    "model: ultra",
                    "commandExecutionPolicy: unknown",
                    "hidden: maybe",
                    'skills: ["review"]',
                    "futureBehavior: true",
                ],
                BODY,
            ),
        );
        expect(parsed.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "antigravity.subagent_markdown_field_invalid",
                "antigravity.subagent_markdown_selector_invalid",
                "antigravity.subagent_skill_binding_pending",
                "antigravity.unknown_behavioral_frontmatter",
            ]),
        );
    });

    it("restores current bytes, rebases portable fields, and keeps native layout/comments", () => {
        const parsed = parseCandidate(NATIVE);
        const canonical = canonicalOf(parsed);
        const projection = projectAntigravityMarkdownSubagentCanonical(canonical, JSON.stringify(parsed.instruction));
        expect(projection).not.toBeNull();
        expect(serializeAntigravityMarkdownSubagent(projection as NonNullable<typeof projection>)).toContain(
            "commandExecutionPolicy: sandbox",
        );
        expect(rebaseAntigravityMarkdownSubagent(NATIVE, projection as NonNullable<typeof projection>)).toBe(NATIVE);

        canonical.typeData.name = "oaam-auditor";
        canonical.typeData.description = "Audit the isolated fixture";
        canonical.typeData.tools.availability.base = { mode: "none" };
        canonical.typeData.directInvocation = { mode: "user_selectable", initialPrompt: { mode: "none" } };
        canonical.typeData.execution.model = { mode: "inherit" };
        canonical.typeData.execution.permission = { mode: "inherit" };
        canonical.typeData.presentation.listing = "hidden";
        const changedBody = BODY.replace("SOURCE", "REBASE");
        const changed = projectAntigravityMarkdownSubagentCanonical(canonical, instruction(changedBody));
        const rebased = rebaseAntigravityMarkdownSubagent(NATIVE, changed as NonNullable<typeof changed>);
        expect(rebased).toContain("# preserve this native comment");
        expect(rebased).toContain('name: "oaam-auditor"');
        expect(rebased).toContain("tools: []");
        expect(rebased).toContain("mainAgent: true");
        expect(rebased).not.toContain("model:");
        expect(rebased).not.toContain("commandExecutionPolicy:");
        expect(rebased).toContain("hidden: true");
        expect(rebased?.endsWith(changedBody)).toBe(true);
    });

    it("supports adding safe optional fields and fails closed before deleting commented behavior", () => {
        const minimalText = markdown(["name: minimal", "description: Minimal", "subagent: true"], BODY);
        const parsed = parseCandidate(minimalText);
        const canonical = canonicalOf(parsed);
        canonical.typeData.execution.model = {
            mode: "selected",
            dialectId: ANTIGRAVITY_SUBAGENT_MODEL_DIALECT,
            selector: "flash",
            relativeTier: 1,
        };
        const projection = projectAntigravityMarkdownSubagentCanonical(canonical, instruction(BODY));
        expect(rebaseAntigravityMarkdownSubagent(minimalText, projection as NonNullable<typeof projection>)).toContain(
            'model: "flash"\n---',
        );

        const commented = NATIVE.replace("model: pro", "model: pro # preserve selector rationale");
        canonical.typeData.execution.model = { mode: "inherit" };
        const inherited = projectAntigravityMarkdownSubagentCanonical(canonical, instruction(BODY));
        expect(rebaseAntigravityMarkdownSubagent(commented, inherited as NonNullable<typeof inherited>)).toBeNull();
    });

    it("rewrites an uncommented multiline selector and blocks a commented multiline selector", () => {
        const multiline = markdown(
            ["name: multiline", "description: Multiline", "tools:", "  - view_file", "  - run_command"],
            BODY,
        );
        const parsed = parseCandidate(multiline);
        const canonical = canonicalOf(parsed);
        canonical.typeData.tools.availability.base = { mode: "none" };
        const projection = projectAntigravityMarkdownSubagentCanonical(canonical, instruction(BODY));
        expect(rebaseAntigravityMarkdownSubagent(multiline, projection as NonNullable<typeof projection>)).toContain(
            "tools: []\n---",
        );

        const commented = multiline.replace("  - run_command", "  # preserve tool reason\n  - run_command");
        expect(rebaseAntigravityMarkdownSubagent(commented, projection as NonNullable<typeof projection>)).toBeNull();
    });

    it("allows body-only reverse and rejects frontmatter or malformed document drift", () => {
        const changedBody = BODY.replace("SOURCE", "REVERSE");
        expect(reverseAntigravityMarkdownSubagent(NATIVE, NATIVE.replace(BODY, changedBody))).toBe(instruction(changedBody));
        expect(reverseAntigravityMarkdownSubagent(NATIVE, NATIVE.replace("hidden: false", "hidden: true"))).toBeNull();
        expect(reverseAntigravityMarkdownSubagent("not frontmatter", NATIVE)).toBeNull();
        expect(reverseAntigravityMarkdownSubagent(NATIVE, "not frontmatter")).toBeNull();
    });

    it("blocks foreign or unrepresentable canonical behavior field by field", () => {
        const parsed = parseCandidate(NATIVE);
        const cases: Array<(canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>) => void> = [
            (value) => {
                value.typeData.promptContextPolicy = { mode: "selected", dialectId: "foreign", selectors: ["context"] };
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
                value.typeData.execution.workspaceIsolation = { mode: "isolated_worktree" };
            },
            (value) => {
                value.typeData.execution.model = {
                    mode: "selected",
                    dialectId: "foreign-model",
                    selector: "pro",
                    relativeTier: 10,
                };
            },
            (value) => {
                value.typeData.execution.permission = {
                    mode: "selected",
                    dialectId: "foreign-policy",
                    selector: "sandbox",
                    effect: "auto_approve_selected_operations",
                };
            },
            (value) => {
                value.typeData.directInvocation = { mode: "user_selectable", initialPrompt: { mode: "required" } };
            },
            (value) => {
                value.typeData.presentation.color = { mode: "selected", value: "blue" };
            },
        ];
        for (const mutate of cases) {
            const canonical = canonicalOf(parsed);
            mutate(canonical);
            expect(projectAntigravityMarkdownSubagentCanonical(canonical, instruction(BODY))).toBeNull();
        }
        expect(projectAntigravityMarkdownSubagentCanonical(canonicalOf(parsed), "not json")).toBeNull();
        expect(projectAntigravityMarkdownSubagentCanonical(canonicalOf(parsed), "[]")).toBeNull();
        expect(
            projectAntigravityMarkdownSubagentCanonical(
                canonicalOf(parsed),
                JSON.stringify({ schemaVersion: 2, sections: [{ title: "", content: BODY }] }),
            ),
        ).toBeNull();
        expect(
            projectAntigravityMarkdownSubagentCanonical(canonicalOf(parsed), JSON.stringify({ schemaVersion: 1, sections: [] })),
        ).toBeNull();
        expect(
            projectAntigravityMarkdownSubagentCanonical(
                canonicalOf(parsed),
                JSON.stringify({ schemaVersion: 1, sections: [{ title: "wrong", content: BODY, extra: true }] }),
            ),
        ).toBeNull();

        const nonRuntimeTool = canonicalOf(parsed);
        nonRuntimeTool.typeData.tools.availability.base = {
            mode: "allowlist",
            allowed: [{ mode: "portable_tool", tool: "read_file" }],
        };
        expect(projectAntigravityMarkdownSubagentCanonical(nonRuntimeTool, instruction(BODY))).toBeNull();
    });
});

function markdown(fields: readonly string[], body: string): string {
    return `---\n${fields.join("\n")}\n---\n${body}`;
}

function instruction(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function parseCandidate(text: string) {
    const parsed = parseAntigravityMarkdownSubagent(text, ".agents/agents/fixture.md");
    if (parsed.disposition !== "candidate") throw new Error("expected Markdown Subagent candidate");
    return parsed;
}

function canonicalOf(parsed: ReturnType<typeof parseCandidate>): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return { kind: "Subagent", typeData: structuredClone(parsed.typeData) };
}
