import { describe, expect, it } from "vitest";
import { opencodeProvider } from "../src/opencode-provider";
import {
    appRawReadInput,
    configRoot,
    failed,
    fm,
    permissionRule,
    projectCapabilities,
    projectRoot,
    rawReadInput,
    readInput,
    readProject,
    requiredCapability,
} from "./opencode-source-test-fixtures";

describe("OpenCode portable source asset parsing", () => {
    it("binds the same embedded declaration loader to the independent Desktop entry", async () => {
        const root = projectRoot();
        const capability = projectCapabilities(["Guidance"], "OPENCODE_APP");
        const result = await opencodeProvider.read(
            appRawReadInput(root, capability, { "AGENTS.md": "# OpenCode App guidance\n" }),
        );

        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                status: "complete",
                nativeRepresentation: expect.objectContaining({ dialectId: "opencode-guidance-markdown-v1" }),
            }),
        ]);
        expect(result.sourceParseReports[0]?.sourceReadObligationIds).toEqual(["app-obligation-Guidance-0"]);
    });

    it("maps command execution fields and keeps ambiguous or malformed commands incomplete", async () => {
        const result = await readProject(["Workflow"], {
            ".opencode/commands/rich.md": fm(
                "description: Review safely\nagent: reviewer\nsubtask: true\nmodel: provider/model\nvariant: high",
                [
                    "Review $ARGUMENTS then $1 and $2. !`git status` @. @docs/runbook.md @reviewer @reviewer",
                    "```",
                    "@fenced-agent",
                    "```",
                ].join("\n"),
            ),
            "docs/runbook.md": "# Runbook\n",
            ".opencode/commands/general.md": fm("agent: general", "General task"),
            ".opencode/commands/caller.md": fm("agent: build\nsubtask: false", "Caller task"),
            ".opencode/commands/ambiguous.md": fm("agent: reviewer", "Ambiguous task"),
            ".opencode/commands/plain.md": "Plain $3 task\n",
            ".opencode/commands/empty.md": fm("description: Empty", ""),
            ".opencode/commands/typed.md": fm(
                "description: [wrong]\nsubtask: yes\nmodel: false\nvariant: 4\nfuture: true",
                "Typed task",
            ),
            ".opencode/commands/binary.md": new Uint8Array([0xff]),
        });
        const rich = result.candidates.find((candidate) => candidate.displayName === "rich");
        expect(rich).toMatchObject({
            status: "complete",
            workflowExecutionAgentBindingInput: {
                bindingInputKind: "raw_selector",
                rawTarget: "reviewer",
                required: true,
            },
            typeData: {
                implementation: {
                    execution: {
                        mode: "isolated",
                        agent: { mode: "agent_runtime_named", selector: "reviewer" },
                        model: { mode: "selected", selector: "provider/model", relativeTier: -1 },
                        effort: { mode: "selected", selector: "high", relativeTier: -1 },
                        shell: { mode: "agent_runtime_default" },
                    },
                },
                invocation: { argumentNames: ["ARGUMENTS", "1", "2"] },
            },
        });
        expect(rich?.files[0]?.references).toEqual([
            {
                kind: "include",
                rawTarget: ".",
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            },
            {
                kind: "include",
                rawTarget: "docs/runbook.md",
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            },
            {
                kind: "execute",
                rawTarget: "reviewer",
                required: true,
                diagnostics: [],
                resolution: "unresolved",
            },
            {
                kind: "execute",
                rawTarget: "fenced-agent",
                required: true,
                diagnostics: [],
                resolution: "unresolved",
            },
        ]);
        expect(result.candidates.find((candidate) => candidate.displayName === "general")).toMatchObject({
            status: "incomplete",
            diagnostics: [expect.objectContaining({ code: "opencode.workflow_agent_mode_unresolved" })],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "caller")?.typeData).toMatchObject({
            implementation: {
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_named", selector: "build" },
                },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "plain")).toMatchObject({
            status: "complete",
            typeData: { invocation: { argumentNames: ["3"] } },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "ambiguous")).toMatchObject({
            status: "incomplete",
            diagnostics: [expect.objectContaining({ code: "opencode.workflow_agent_mode_unresolved" })],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "empty")?.status).toBe("incomplete");
        expect(
            result.candidates.find((candidate) => candidate.displayName === "typed")?.diagnostics.map((item) => item.code),
        ).toEqual(expect.arrayContaining(["opencode.frontmatter_type_mismatch", "opencode.declaration_unknown_behavior"]));
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "opencode.declaration_not_utf8" }));
    });

    it("blocks global command @ references when no exact invocation project can classify them", async () => {
        const root = configRoot();
        const workflow = requiredCapability(
            (row) =>
                row.assetKind === "Workflow" &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "config" &&
                row.rootLocatorKind === "runtime_known_rule",
        );
        const result = await opencodeProvider.read(
            rawReadInput(root, [workflow], {
                "commands/global.md": "Use @reviewer.\n",
            }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                status: "incomplete",
                assetCandidateStatus: "incomplete",
                diagnostics: [
                    expect.objectContaining({
                        code: "opencode.workflow_reference_context_unavailable",
                    }),
                ],
            }),
        ]);
    });

    it("keeps absolute global command references external without inventing a project root", async () => {
        const root = configRoot();
        const workflow = requiredCapability(
            (row) =>
                row.assetKind === "Workflow" &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "config" &&
                row.rootLocatorKind === "runtime_known_rule",
        );
        const result = await opencodeProvider.read(
            rawReadInput(root, [workflow], {
                "commands/global.md": "Read @/tmp/context.md and @~/private/context.md.\n",
            }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                status: "complete",
                files: [
                    expect.objectContaining({
                        references: [
                            expect.objectContaining({
                                rawTarget: "/tmp/context.md",
                                resolution: "external",
                            }),
                            expect.objectContaining({
                                rawTarget: "~/private/context.md",
                                resolution: "external",
                            }),
                        ],
                    }),
                ],
            }),
        ]);
    });

    it("fails closed when Core cannot classify a project command reference", async () => {
        const root = projectRoot();
        const workflow = projectCapabilities(["Workflow"])[0];
        if (workflow === undefined) throw new Error("missing Workflow capability");
        const input = rawReadInput(root, [workflow], {
            ".opencode/commands/restricted.md": "Read @docs/restricted.md.\n",
        });
        const baseReadAccess = input.readAccess;
        input.readAccess = {
            ...baseReadAccess,
            async resolveEntry(obligationId, sourceRootId, relativePath) {
                if (relativePath === "docs/restricted.md") {
                    return failed("permission-denied-reference", "permission_denied");
                }
                return baseReadAccess.resolveEntry(obligationId, sourceRootId, relativePath);
            },
        };

        const result = await opencodeProvider.read(input);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                status: "incomplete",
                files: [
                    expect.objectContaining({
                        references: [
                            expect.objectContaining({
                                rawTarget: "docs/restricted.md",
                                required: true,
                                resolution: "unresolved",
                                diagnostics: [
                                    expect.objectContaining({
                                        code: "opencode.workflow_reference_resolution_failed",
                                        causeKind: "permission_denied",
                                    }),
                                ],
                            }),
                        ],
                    }),
                ],
            }),
        ]);
    });

    it("classifies project command references that escape the selected root as external", async () => {
        const result = await readProject(["Workflow"], {
            ".opencode/commands/external.md": "Read @../secret.md and @~/private/context.md.\n",
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                status: "complete",
                files: [
                    expect.objectContaining({
                        references: [
                            expect.objectContaining({
                                rawTarget: "../secret.md",
                                required: false,
                                resolution: "external",
                            }),
                            expect.objectContaining({
                                rawTarget: "~/private/context.md",
                                required: false,
                                resolution: "external",
                            }),
                        ],
                    }),
                ],
            }),
        ]);
    });

    it("keeps declarations with an empty filename-derived name incomplete", async () => {
        const workflow = await readProject(["Workflow"], {
            ".opencode/commands/.md": "Command body\n",
        });
        expect(workflow.candidates).toEqual([
            expect.objectContaining({
                displayName: "",
                status: "incomplete",
                diagnostics: [expect.objectContaining({ code: "opencode.workflow_name_missing" })],
            }),
        ]);

        const subagent = await readProject(["Subagent"], {
            ".opencode/agents/.md": fm("description: Empty path name", "Agent body"),
        });
        expect(subagent.candidates).toEqual([
            expect.objectContaining({
                displayName: "",
                status: "incomplete",
                diagnostics: [expect.objectContaining({ code: "opencode.subagent_name_missing" })],
            }),
        ]);
    });

    it("preserves a complete Skill folder and rejects unsafe or structurally incomplete Skill roots", async () => {
        const result = await readProject(["Skill"], {
            ".opencode/skills/demo/SKILL.md": fm(
                "name: demo\ndescription: Demo\nslash: true\nlicense: MIT\ncompatibility: linux\nmetadata:\n  owner: oaam",
                "Read [details](docs/details.md), [external](https://example.com), and [escape](../../escape.md).",
            ),
            ".opencode/skills/demo/docs/details.md": "[entry](../SKILL.md)\n",
            ".opencode/skills/demo/config.json": '{"enabled":true}\n',
            ".opencode/skills/demo/code.js": "export const value = 1;\n",
            ".opencode/skills/demo/code.ts": "export const value = 2;\n",
            ".opencode/skills/demo/config.JSONC": "{}\n",
            ".opencode/skills/demo/notes.txt": "notes\n",
            ".opencode/skills/demo/value.custom": "custom\n",
            ".opencode/skills/demo/image.bin": new Uint8Array([0, 255, 1]),
            ".opencode/skills/unknown/SKILL.md": fm(
                "name: unknown\ndescription: Unknown\nmetadata:\n  count: 2\nlicense: [MIT]\nfuture: yes",
                "Body",
            ),
            ".opencode/skills/bad-slash/SKILL.md": fm("name: bad-slash\ndescription: Bad slash\nslash: maybe", "Body"),
            ".opencode/skills/no-name/SKILL.md": fm("description: Missing", "Body"),
            ".opencode/skills/no-description/SKILL.md": fm("name: missing", "Body"),
            ".opencode/skills/no-body/SKILL.md": fm("name: empty\ndescription: Empty", ""),
            ".opencode/skills/hook/SKILL.md": fm("name: hook\ndescription: Hook\nhooks: true", "Body"),
            ".opencode/skills/shell/SKILL.md": fm("name: shell\ndescription: Shell\nshell: bash", "Body"),
            ".opencode/skills/binary/SKILL.md": new Uint8Array([0xff]),
            ".opencode/skills/README.md": "ignored",
        });
        const demo = result.candidates.find((candidate) => candidate.displayName === "demo");
        expect(demo?.files.map((file) => [file.logicalPath, file.contentKind, file.mediaType])).toEqual([
            ["SKILL.md", "text", "text/markdown"],
            ["code.js", "text", "text/javascript"],
            ["code.ts", "text", "text/typescript"],
            ["config.JSONC", "text", "application/json"],
            ["config.json", "text", "application/json"],
            ["docs/details.md", "text", "text/markdown"],
            ["image.bin", "binary", "application/octet-stream"],
            ["notes.txt", "text", "text/plain"],
            ["value.custom", "text", "application/octet-stream"],
        ]);
        expect(demo?.files[0]?.references).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    rawTarget: "docs/details.md",
                    resolution: "resolved_version_file",
                }),
                expect.objectContaining({
                    rawTarget: "https://example.com",
                    resolution: "external",
                }),
                expect.objectContaining({ rawTarget: "../../escape.md", resolution: "unresolved" }),
            ]),
        );
        expect(demo?.typeData).toMatchObject({
            invocation: {
                user: { mode: "direct", commandName: "demo" },
                model: { mode: "model_decision" },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "bad-slash")).toMatchObject({
            status: "incomplete",
            diagnostics: [expect.objectContaining({ code: "opencode.frontmatter_type_mismatch" })],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "unknown")).toMatchObject({
            status: "incomplete",
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "opencode.frontmatter_type_mismatch" }),
                expect.objectContaining({ code: "opencode.declaration_unknown_behavior" }),
            ]),
        });
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "opencode.skill_required_content_missing",
                "opencode.skill_executable_source_rejected",
                "opencode.declaration_not_utf8",
            ]),
        );
        expect(result.candidates.map((candidate) => candidate.displayName).sort()).toEqual(["bad-slash", "demo", "unknown"]);
    });

    it("assigns nested Skill resources only to their nearest Skill root", async () => {
        const result = await readProject(["Skill"], {
            ".opencode/skills/outer/SKILL.md": fm("name: outer\ndescription: Outer", "Outer body"),
            ".opencode/skills/outer/root.txt": "outer resource",
            ".opencode/skills/outer/inner/SKILL.md": fm("name: inner\ndescription: Inner", "Inner body"),
            ".opencode/skills/outer/inner/inner.txt": "inner resource",
            ".opencode/skills/invalid/SKILL.md": fm("name: invalid", "Missing description"),
            ".opencode/skills/invalid/child/SKILL.md": fm("name: child\ndescription: Child", "Child body"),
            ".opencode/skills/invalid/child/value.txt": "child resource",
        });
        const filesByName = new Map(
            result.candidates.map((candidate) => [candidate.displayName, candidate.files.map((file) => file.logicalPath)]),
        );
        expect(filesByName).toEqual(
            new Map([
                ["child", ["SKILL.md", "value.txt"]],
                ["inner", ["SKILL.md", "inner.txt"]],
                ["outer", ["SKILL.md", "root.txt"]],
            ]),
        );
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode.skill_required_content_missing",
                path: ".opencode/skills/invalid/SKILL.md",
            }),
        );
    });

    it("rejects hooks, inline MCP, and remote-isolation Subagents as whole sources", async () => {
        const result = await readProject(["Subagent"], {
            ".opencode/agents/hook.md": fm("description: Hooked\nhooks: true", "Body"),
            ".opencode/agents/mcp.md": fm("description: MCP\nmcpServers: local", "Body"),
            ".opencode/agents/remote.md": fm("description: Remote\nisolation: remote", "Body"),
        });
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.filter((item) => item.code === "opencode.subagent_excluded_source")).toHaveLength(3);
        expect(result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "ignored")).toHaveLength(
            3,
        );
        expect(result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "parsed")).toEqual([]);
    });

    it("separates current and legacy Subagent fields without widening malformed, disabled, or primary-only declarations", async () => {
        const result = await readProject(["Subagent"], {
            ".opencode/agents/rich.md": fm(
                [
                    "name: reviewer",
                    "description: Reviews changes",
                    "mode: subagent",
                    "model: provider/model",
                    "variant: high",
                    "temperature: 0.2",
                    "top_p: 0.8",
                    "steps: 4",
                    "hidden: true",
                    "color: info",
                    "tools:",
                    "  read: true",
                    "  shell: false",
                    "permission:",
                    "  write: ask",
                    "  network: deny",
                    "  read: allow",
                ].join("\n"),
                "Review carefully.",
            ),
            ".opencode/agents/precedence.md": fm(
                [
                    "description: Permission precedence",
                    "tools:",
                    "  write: true",
                    "  shell: false",
                    "permission:",
                    "  '*': ask",
                    "  edit: deny",
                    "  bash: allow",
                ].join("\n"),
                "Preserve rule order.",
            ),
            ".opencode/agents/default.md": fm("description: Default agent", "Default body"),
            ".opencode/agents/private.md": fm(
                ["description: Private options", "options:", "  reasoningEffort: high", "futureFlag: enabled"].join("\n"),
                "Private body",
            ),
            ".opencode/agents/current.md": fm(
                ["description: Current schema", "mode: subagent", "disabled: false", "system: ignored frontmatter system"].join(
                    "\n",
                ),
                "Current body wins.",
            ),
            ".opencode/agents/current-disabled.md": fm("description: Current disabled\ndisabled: true", "Disabled body"),
            ".opencode/agents/current-request.md": fm("description: Current request\nrequest:\n  body: custom", "Request body"),
            ".opencode/agents/current-permissions.md": fm(
                [
                    "description: Current permissions",
                    "permissions:",
                    "  - action: read",
                    "    resource: '*'",
                    "    effect: allow",
                ].join("\n"),
                "Permissions body",
            ),
            ".opencode/agents/mixed-schema.md": fm("name: ignored-name\ndescription: Mixed\nsystem: request data", "Mixed body"),
            ".opencode/agents/max.md": fm("description: Max steps\nmaxSteps: 2", "Max body"),
            ".opencode/agents/invalid.md": fm(
                [
                    "description: Invalid",
                    "mode: future",
                    "steps: 0",
                    "maxSteps: -1",
                    "temperature: cold",
                    "top_p: []",
                    "color: blue",
                    "tools:",
                    "  read: maybe",
                    "permission:",
                    "  write: later",
                    "options: true",
                    "future: yes",
                ].join("\n"),
                "Invalid body",
            ),
            ".opencode/agents/bad-maps.md": fm("description: Bad maps\ntools: []\npermission: []", "Bad maps body"),
            ".opencode/agents/disabled.md": fm("description: Disabled\ndisable: true", "Disabled body"),
            ".opencode/agents/primary.md": fm("description: Primary\nmode: primary", "Primary body"),
            ".opencode/agents/missing.md": "No description\n",
            ".opencode/agents/binary.md": new Uint8Array([0xff]),
        });
        const rich = result.candidates.find((candidate) => candidate.displayName === "rich");
        expect(rich).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "opencode.subagent_frontmatter_name_ignored" })],
            typeData: {
                name: "rich",
                directInvocation: { mode: "delegated_only" },
                tools: {
                    permission: {
                        rules: [
                            {
                                selector: {
                                    mode: "agent_runtime_tool",
                                    selector: {
                                        dialectId: "opencode-permission-selector-v1",
                                        selector: "read",
                                    },
                                },
                                action: "preapproved",
                            },
                            {
                                selector: {
                                    mode: "agent_runtime_tool",
                                    selector: {
                                        dialectId: "opencode-permission-selector-v1",
                                        selector: "shell",
                                    },
                                },
                                action: "deny",
                            },
                            {
                                selector: {
                                    mode: "agent_runtime_tool",
                                    selector: {
                                        dialectId: "opencode-permission-selector-v1",
                                        selector: "write",
                                    },
                                },
                                action: "ask",
                            },
                            {
                                selector: {
                                    mode: "agent_runtime_tool",
                                    selector: {
                                        dialectId: "opencode-permission-selector-v1",
                                        selector: "network",
                                    },
                                },
                                action: "deny",
                            },
                        ],
                    },
                },
                execution: {
                    turnLimit: { mode: "bounded", limit: 4 },
                    model: { mode: "selected", selector: "provider/model" },
                    effort: { mode: "selected", selector: "high" },
                    sampling: {
                        temperature: { mode: "selected", value: 0.2 },
                        topP: { mode: "selected", value: 0.8 },
                    },
                },
                presentation: {
                    listing: "hidden",
                    color: { mode: "selected", selector: "info" },
                },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "precedence")?.typeData).toMatchObject({
            tools: {
                permission: {
                    rules: [
                        permissionRule("edit", "deny"),
                        permissionRule("shell", "deny"),
                        permissionRule("*", "ask"),
                        permissionRule("bash", "preapproved"),
                    ],
                },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "default")?.typeData).toMatchObject({
            directInvocation: { mode: "user_selectable" },
            execution: { turnLimit: { mode: "agent_runtime_default" } },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "max")?.typeData).toMatchObject({
            execution: { turnLimit: { mode: "bounded", limit: 2 } },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "private")).toMatchObject({
            status: "complete",
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "opencode.subagent_private_frontmatter_preserved", severity: "warning" }),
            ]),
            nativeRepresentation: {
                files: [expect.objectContaining({ relativePath: ".opencode/agents/private.md" })],
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "current")).toMatchObject({
            status: "complete",
            files: [expect.objectContaining({ text: expect.stringContaining("Current body wins.") })],
            typeData: {
                directInvocation: { mode: "delegated_only" },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "current-request")).toMatchObject({
            status: "incomplete",
            diagnostics: [expect.objectContaining({ code: "opencode.subagent_request_unowned" })],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "current-permissions")).toMatchObject({
            status: "incomplete",
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "opencode.frontmatter_unsupported" }),
                expect.objectContaining({
                    code: "opencode.subagent_permissions_shape_unsupported",
                }),
            ]),
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "mixed-schema")).toMatchObject({
            status: "incomplete",
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "opencode.subagent_frontmatter_name_ignored" }),
                expect.objectContaining({
                    code: "opencode.subagent_current_field_in_legacy_document",
                }),
            ]),
        });
        expect(
            result.candidates.find((candidate) => candidate.displayName === "invalid")?.diagnostics.map((item) => item.code),
        ).toEqual(
            expect.arrayContaining([
                "opencode.subagent_private_frontmatter_preserved",
                "opencode.subagent_mode_invalid",
                "opencode.subagent_steps_invalid",
                "opencode.subagent_color_invalid",
                "opencode.frontmatter_type_mismatch",
            ]),
        );
        expect(
            result.candidates.find((candidate) => candidate.displayName === "bad-maps")?.diagnostics.map((item) => item.code),
        ).toEqual(
            expect.arrayContaining(["opencode.frontmatter_type_mismatch", "opencode.subagent_permission_shape_unsupported"]),
        );
        expect(result.candidates.map((candidate) => candidate.displayName).sort()).toEqual([
            "bad-maps",
            "current",
            "current-permissions",
            "current-request",
            "default",
            "invalid",
            "max",
            "mixed-schema",
            "precedence",
            "private",
            "rich",
        ]);
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "opencode.subagent_disabled",
                "opencode.primary_agent_not_collected",
                "opencode.subagent_description_missing",
                "opencode.declaration_not_utf8",
            ]),
        );
    });

    it("reports mixed JSON and JSONC sections without importing container fragments or secrets", async () => {
        const result = await opencodeProvider.read(
            readInput(configRoot(), ["Workflow", "Skill", "Subagent"], {
                "opencode.jsonc": [
                    "{",
                    "  /* current-schema sections remain report-only */",
                    "  // escaped content exercises the bounded JSONC lexer",
                    '  "path": "a\\\\b\\"c",',
                    '  "instructions": ["docs/rules.md"],',
                    '  "commands": { "review": { "template": "do not persist" } },',
                    '  "agents": { "reviewer": { "prompt": "TOP-SECRET" } },',
                    '  "skills": ["./private-skills"],',
                    "}",
                ].join("\n"),
                "opencode.json": JSON.stringify({
                    command: { legacy: { template: "legacy command" } },
                    agent: { legacy: { prompt: "legacy agent" } },
                    skills: { paths: ["./legacy-skills"] },
                }),
                "config.json": "{",
            }),
        );
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["opencode.manifest_fragment_deferred", "opencode.manifest_parse_failed"]),
        );
        expect(
            result.diagnostics.filter((item) => item.code === "opencode.manifest_fragment_deferred").map((item) => item.message),
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining("commands"),
                expect.stringContaining("command"),
                expect.stringContaining("agents"),
                expect.stringContaining("agent"),
                expect.stringContaining("skills"),
            ]),
        );
        expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
        expect(JSON.stringify(result)).not.toContain("do not persist");
        expect(
            result.sourceParseReports[0]?.readEntryDispositions.every(
                (item) => item.disposition === "ignored" || item.disposition === "traversed",
            ),
        ).toBe(true);
        expect(result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "ignored")).toHaveLength(
            9,
        );
    });
});
