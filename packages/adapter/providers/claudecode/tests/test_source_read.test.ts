import { describe, expect, it } from "vitest";
import { claudecodeProvider } from "../src/claudecode-provider";
import { CLAUDECODE_ASSET_READER_REGISTRY } from "../src/claudecode-source-read-registry";
import { configRoot, memoryRoot, projectRoot, readInput } from "./claudecode-test-fixtures";

describe("Claude Code source read", () => {
    it("declares one concrete reader for every AssetKind without a fallback", () => {
        expect(Object.keys(CLAUDECODE_ASSET_READER_REGISTRY).sort()).toEqual([
            "Guidance",
            "Memory",
            "Rule",
            "Skill",
            "Subagent",
            "Workflow",
        ]);
        expect(Object.values(CLAUDECODE_ASSET_READER_REGISTRY).map((entry) => entry.disposition)).toEqual([
            "reader",
            "reader",
            "reader",
            "reader",
            "reader",
            "reader",
        ]);
    });

    it.each([
        "user_provided_path",
        "project_registry_entry",
    ] as const)("extracts the five declaration families from a %s project root", async (locatorKind) => {
        const root = projectRoot();
        if (locatorKind === "project_registry_entry")
            root.locatorEvidence = [{ locatorKind, locatorKey: "fixture-cli-index", evidenceLevel: "local_artifact" }];
        const input = readInput(root, ["Guidance", "Rule", "Workflow", "Skill", "Subagent"], {
            "CLAUDE.md": "# Project\n@docs/context.md\n",
            "CLAUDE.local.md": "# Private\n",
            ".claude/CLAUDE.md": "# Nested\n",
            ".claude/rules/nested/typescript.md": `---\nname: TypeScript\ndescription: TS files\npaths: [src/**/*.ts]\n---\nUse strict mode.\n`,
            ".claude/commands/team/review.md": `---\nname: review\ndescription: Review changes\nargument-hint: [scope]\narguments: [scope]\nallowed-tools: [Read, "Bash(git diff)"]\ndisallowed-tools: [Write]\nmodel: sonnet\neffort: high\nshell: bash\ncontext: fork\nagent: reviewer\n---\nReview $ARGUMENTS.\n`,
            ".claude/workflows/tools/timezone.js": {
                text: `export const meta = { name: "timezone", description: "Lookup timezone" };\nexport default async function run() { return "UTC"; }\n`,
                executable: true,
            },
            ".claude/workflows/tools/resources/marker.txt": "OAAM workflow resource\n",
            ".claude/workflows/tools/resources/marker.bin": new Uint8Array([0, 255, 2]),
            ".claude/workflows/tools/scripts/helper.js": {
                text: "export const helper = 'OAAM_WORKFLOW_HELPER';\n",
                executable: true,
            },
            ".claude/skills/explain/SKILL.md": `---\nname: explain\ndescription: Explain code\nallowed-tools: [Read]\npaths: [src/**]\nmetadata:\n  owner: user\n---\nRead [details](docs/details.md).\n`,
            ".claude/skills/explain/docs/details.md": "# Details\n",
            ".claude/skills/explain/image.bin": new Uint8Array([0, 255, 1]),
            ".claude/agents/team/reviewer.md": `---\nname: reviewer\ndescription: Reviews changes\ntools: [Read, "Bash(git diff)"]\ndisallowed-tools: [Write]\npermissionMode: plan\nmemory: project\nbackground: true\ninitialPrompt: /review staged\nmodel: opus\neffort: max\nmaxTurns: 4\nisolation: worktree\ncolor: blue\n---\nReview carefully.\n`,
        });
        const result = await claudecodeProvider.read(input);
        expect(result.diagnostics).toEqual([]);
        expect(result.candidates.map((candidate) => candidate.kind).sort()).toEqual(
            ["Guidance", "Guidance", "Guidance", "Rule", "Skill", "Subagent", "Workflow", "Workflow"].sort(),
        );
        expect(
            result.candidates.find((candidate) => candidate.kind === "Guidance" && candidate.displayName === "CLAUDE.local.md")
                ?.promotionSafety,
        ).toBe("requires_user_confirmation");
        const skill = result.candidates.find((candidate) => candidate.kind === "Skill");
        expect(skill).toMatchObject({
            status: "complete",
            assetCandidateStatus: "importable",
            typeData: { name: "explain", invocation: { pathCondition: { mode: "required" } } },
        });
        expect(skill?.files.map((file) => [file.logicalPath, file.contentKind])).toEqual([
            ["SKILL.md", "text"],
            ["docs/details.md", "text"],
            ["image.bin", "binary"],
        ]);
        const command = result.candidates.find(
            (candidate) => candidate.kind === "Workflow" && candidate.displayName === "review",
        );
        expect(command).toMatchObject({
            workflowExecutionAgentBindingInput: {
                bindingInputKind: "raw_selector",
                rawTarget: "reviewer",
                required: true,
            },
            typeData: {
                implementation: {
                    kind: "instructions",
                    execution: { mode: "isolated" },
                },
            },
        });
        expect(
            result.candidates.find(
                (candidate) =>
                    candidate.kind === "Guidance" &&
                    candidate.nativeRepresentation.representationSource === "separate_files" &&
                    candidate.nativeRepresentation.files[0]?.relativePath === ".claude/CLAUDE.md",
            )?.nativeRepresentation,
        ).toMatchObject({ files: [{ relativePath: ".claude/CLAUDE.md" }] });
        expect(result.candidates.find((candidate) => candidate.kind === "Rule")?.nativeRepresentation).toMatchObject({
            files: [{ relativePath: ".claude/rules/nested/typescript.md" }],
        });
        expect(result.candidates.find((candidate) => candidate.kind === "Rule")?.typeData).toMatchObject({
            name: "TypeScript",
        });
        expect(command?.nativeRepresentation).toMatchObject({
            files: [{ relativePath: ".claude/commands/team/review.md" }],
        });
        const javascriptWorkflow = result.candidates.find((candidate) => candidate.displayName === "timezone");
        expect(javascriptWorkflow?.files.map((file) => [file.logicalPath, file.contentKind, file.executable])).toEqual([
            ["resources/marker.bin", "binary", false],
            ["resources/marker.txt", "text", false],
            ["scripts/helper.js", "text", true],
            ["timezone.js", "text", true],
        ]);
        expect(javascriptWorkflow?.nativeRepresentation).toMatchObject({
            files: [
                { relativePath: ".claude/workflows/tools/resources/marker.bin" },
                { relativePath: ".claude/workflows/tools/resources/marker.txt" },
                { relativePath: ".claude/workflows/tools/scripts/helper.js", executable: true },
                { relativePath: ".claude/workflows/tools/timezone.js", executable: true },
            ],
        });
        expect(result.candidates.find((candidate) => candidate.kind === "Subagent")?.nativeRepresentation).toMatchObject({
            files: [{ relativePath: ".claude/agents/team/reviewer.md" }],
        });
        const dispositions = result.sourceParseReports[0]?.readEntryDispositions ?? [];
        expect(dispositions.length).toBeGreaterThan(0);
        expect(
            dispositions.every(
                (item) => item.disposition === "ignored" || item.candidateIds.length > 0 || item.disposition === "traversed",
            ),
        ).toBe(true);
    });

    it("projects an importable ordered Memory Catalog separately from topic Units", async () => {
        const root = memoryRoot();
        const input = readInput(root, ["Memory"], {
            "MEMORY.md": "# Index\n- [Testing](topics/testing.md) — Test conventions\n",
            "topics/testing.md": `---\nname: Testing\ndescription: Test conventions\ntype: project\nmetadata:\n  originSessionId: session-1\n---\nUse deterministic fixtures.\n`,
            "unlinked.md": `---\nname: Unlinked\ndescription: Still a memory\nmetadata:\n  type: reference\n---\nUseful note.\n`,
            "team/shared.md": `---\nname: Team\ndescription: Team-only\ntype: project\n---\nDo not import.\n`,
        });
        const result = await claudecodeProvider.read(input);
        expect(result.candidates.map((candidate) => [candidate.displayName, candidate.status])).toEqual([
            ["Claude Code Memory catalog", "complete"],
            ["Testing", "complete"],
            ["Unlinked", "complete"],
        ]);
        expect(result.candidates.find((candidate) => candidate.displayName === "Claude Code Memory catalog")).toMatchObject({
            assetCandidateStatus: "importable",
            memoryCatalogMemberBindingInputs: [
                {
                    rawTarget: "topics/testing.md",
                    routingTitle: "Testing",
                    routingHint: "Test conventions",
                },
            ],
            diagnostics: [],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "Testing")).toMatchObject({
            promotionSafety: "requires_user_confirmation",
            dialectRestorationTransition: { action: "replace" },
            nativeRepresentation: { files: [{ relativePath: "topics/testing.md" }] },
            typeData: { entityRole: "unit", loading: { card: "high", body: "low" } },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "Unlinked")?.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode.memory_topic_unlinked",
                severity: "warning",
            }),
        );
        expect(
            result.sourceParseReports[0]?.readEntryDispositions.some(
                (item) => item.disposition === "ignored" && item.reasonCode === "outside_source_pattern",
            ),
        ).toBe(true);
    });

    it("rejects executable Skills and unsafe Subagents as whole sources", async () => {
        const root = projectRoot();
        const result = await claudecodeProvider.read(
            readInput(root, ["Skill", "Subagent"], {
                ".claude/skills/unsafe/SKILL.md": `---\nname: unsafe\ndescription: unsafe\nhooks: true\n---\nRun !\`id\`.\n`,
                ".claude/skills/unsafe/resource.md": "resource",
                ".claude/agents/remote.md": `---\nname: remote\ndescription: remote\nisolation: remote\n---\nDo work.\n`,
                ".claude/agents/missing.md": "No frontmatter",
            }),
        );
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.map((item) => item.code).sort()).toEqual(
            [
                "claudecode.skill_executable_source_rejected",
                "claudecode.subagent_excluded_source",
                "claudecode.subagent_required_content_missing",
            ].sort(),
        );
        expect(result.sourceParseReports[0]?.status).toBe("skipped_ignored_source");
        expect(result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "parsed")).toEqual([]);
    });

    it("does not turn empty bodies or malformed explicit metadata into complete Skills", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Skill"], {
                ".claude/skills/no-name/SKILL.md": `---\nname: \"\"\ndescription: Invalid name\n---\nBody\n`,
                ".claude/skills/no-name/resource.txt": "owned resource",
                ".claude/skills/no-description/SKILL.md": `---\nname: no-description\ndescription: []\n---\nBody\n`,
                ".claude/skills/no-body/SKILL.md": `---\nname: no-body\ndescription: Empty body\n---\n`,
            }),
        );
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.filter((item) => item.code === "claudecode.skill_required_content_missing")).toHaveLength(3);
        expect(result.sourceParseReports[0]).toMatchObject({ status: "skipped_ignored_source" });
        expect(
            result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "ignored").length,
        ).toBeGreaterThan(0);
        expect(result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "parsed")).toEqual([]);
    });

    it("returns truthful incomplete candidates for malformed portable declarations", async () => {
        const root = projectRoot();
        const result = await claudecodeProvider.read(
            readInput(root, ["Rule", "Workflow", "Skill", "Subagent"], {
                ".claude/rules/bad.md": `---\npaths: []\nunknown: value\n---\nRule body\n`,
                ".claude/commands/bad.md": `---\nname: bad\nhooks: true\n---\nBody\n`,
                ".claude/skills/bad/SKILL.md": `---\nname: bad\ndescription: ok\npaths: [../escape]\nunknown: value\n---\nBody\n`,
                ".claude/agents/bad.md": `---\nname: bad\ndescription: bad\nskills: [missing]\npermissionMode: mystery\nmemory: team\nmaxTurns: -1\nisolation: container\nunknown: value\n---\nBody\n`,
            }),
        );
        expect(result.candidates).toHaveLength(4);
        expect(result.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(result.candidates.flatMap((candidate) => candidate.diagnostics).map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "claudecode.rule_paths_invalid",
                "claudecode.workflow_unowned_behavior",
                "claudecode.skill_paths_invalid",
                "claudecode.subagent_skill_binding_pending",
                "claudecode.subagent_permission_invalid",
                "claudecode.subagent_memory_invalid",
                "claudecode.subagent_turn_limit_invalid",
            ]),
        );
    });

    it("does not invent isolated execution from an agent field without context fork", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow", "Skill"], {
                ".claude/commands/caller.md": `---\nname: caller\ndescription: caller\ncontext: inline\nagent: reviewer\n---\nBody\n`,
                ".claude/commands/unknown-context.md": `---\nname: unknown-context\ndescription: unknown\ncontext: parallel\n---\nBody\n`,
                ".claude/skills/caller/SKILL.md": `---\nname: caller-skill\ndescription: caller\nagent: reviewer\n---\nBody\n`,
            }),
        );
        expect(result.candidates).toHaveLength(3);
        expect(result.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(result.candidates.find((candidate) => candidate.displayName === "caller")?.typeData).toMatchObject({
            implementation: {
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "caller-skill")?.typeData).toMatchObject({
            execution: { mode: "caller" },
        });
        expect(result.candidates.flatMap((candidate) => candidate.diagnostics).map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "claudecode.workflow_agent_without_fork",
                "claudecode.workflow_context_invalid",
                "claudecode.skill_agent_without_fork",
            ]),
        );
    });

    it("separates runtime-native agents from user bindings and follows Claude scalar fallbacks", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow", "Skill", "Subagent"], {
                ".claude/commands/builtin.md": `---\nname: builtin\ndescription: builtin\ncontext: fork\nagent: Explore\nuser-invocable: "false"\ndisable-model-invocation: "true"\nshell: fish\n---\nBody\n`,
                ".claude/skills/builtin/SKILL.md": `---\nname: builtin-skill\ndescription: builtin\ncontext: fork\nagent: general-purpose\nuser-invocable: "false"\ndisable-model-invocation: "true"\n---\nBody\n`,
                ".claude/skills/custom/SKILL.md": `---\nname: custom-skill\ndescription: custom\ncontext: fork\nagent: reviewer\n---\nBody\n`,
                ".claude/agents/background.md": `---\nname: background\ndescription: background\nbackground: "true"\n---\nBody\n`,
                ".claude/agents/foreign.md": `---\nname: foreign\ndescription: foreign\nhidden: true\ntemperature: 0.2\ntopP: 0.8\n---\nBody\n`,
            }),
        );

        const workflow = result.candidates.find((candidate) => candidate.displayName === "builtin");
        expect(workflow).toMatchObject({
            status: "complete",
            workflowExecutionAgentBindingInput: {
                bindingInputKind: "raw_selector",
                rawTarget: "Explore",
                required: false,
            },
            typeData: {
                implementation: {
                    execution: {
                        agent: { mode: "agent_runtime_named", selector: "Explore" },
                        shell: { mode: "selected", selector: "bash" },
                    },
                },
                invocation: { userInvocable: false, agentInvocable: false },
            },
            diagnostics: [expect.objectContaining({ code: "claudecode.workflow_shell_fallback" })],
        });

        expect(result.candidates.find((candidate) => candidate.displayName === "builtin-skill")).toMatchObject({
            status: "complete",
            typeData: {
                invocation: {
                    user: { mode: "not_directly_invocable" },
                    model: { mode: "disabled" },
                },
                execution: {
                    mode: "isolated",
                    agent: { mode: "agent_runtime_named", selector: "general-purpose" },
                },
            },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "custom-skill")).toMatchObject({
            status: "incomplete",
            typeData: {
                execution: { mode: "isolated", agent: { mode: "agent_runtime_default" } },
            },
            diagnostics: [expect.objectContaining({ code: "claudecode.skill_agent_binding_pending" })],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "background")?.typeData).toMatchObject({
            execution: { scheduling: { mode: "always_background" } },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "foreign")).toMatchObject({
            status: "incomplete",
            typeData: {
                execution: {
                    sampling: {
                        temperature: { mode: "agent_runtime_default" },
                        topP: { mode: "agent_runtime_default" },
                    },
                },
                presentation: { listing: "agent_runtime_default" },
            },
            diagnostics: [expect.objectContaining({ code: "claudecode.unknown_behavioral_frontmatter" })],
        });
    });

    it("does not widen malformed Claude permission fields and accepts numeric-string turn limits", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow", "Skill", "Subagent"], {
                ".claude/commands/mixed-tools.md": `---\nname: mixed-tools\ndescription: mixed\nallowed-tools: [Read, 2, true]\n---\nBody\n`,
                ".claude/skills/mixed/SKILL.md": `---\nname: mixed\ndescription: mixed\nallowed-tools: [Read, 2]\narguments: [valid, 2]\nmetadata: 42\n---\nBody\n`,
                ".claude/agents/malformed.md": `---\nname: malformed\ndescription: malformed\ntools: 42\ndisallowedTools: ['*', Write, 1]\ndisallowed-tools: [Bash, false]\nmaxTurns: "4"\nmodel: 42\ncolor: true\n---\nBody\n`,
            }),
        );

        expect(result.candidates.find((candidate) => candidate.displayName === "mixed-tools")).toMatchObject({
            status: "complete",
            typeData: {
                implementation: { toolPolicy: { preapproved: [{ selector: "Read" }] } },
            },
            diagnostics: [expect.objectContaining({ code: "claudecode.workflow_allowed-tools_filtered" })],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "mixed")).toMatchObject({
            status: "incomplete",
            typeData: {
                toolPolicy: { preapproved: [{ selector: "Read" }] },
                invocation: { argumentNames: [] },
            },
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "claudecode.skill_allowed-tools_filtered" }),
                expect.objectContaining({ code: "claudecode.skill_arguments_invalid" }),
                expect.objectContaining({ code: "claudecode.skill_metadata_invalid" }),
            ]),
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "malformed")).toMatchObject({
            status: "complete",
            typeData: {
                tools: {
                    availability: {
                        base: { mode: "none" },
                        unavailable: [{ selector: { selector: "Bash" } }],
                    },
                },
                execution: {
                    turnLimit: { mode: "bounded", limit: 4 },
                    model: { mode: "inherit" },
                },
                presentation: { color: { mode: "agent_runtime_default" } },
            },
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "claudecode.subagent_tools_empty_fallback" }),
                expect.objectContaining({ code: "claudecode.subagent_disallowedtools_filtered" }),
                expect.objectContaining({ code: "claudecode.subagent_disallowed-tools_filtered" }),
                expect.objectContaining({
                    code: "claudecode.subagent_disallowed_tools_alias_overlap",
                }),
                expect.objectContaining({ code: "claudecode.subagent_model_type_fallback" }),
                expect.objectContaining({ code: "claudecode.subagent_color_type_fallback" }),
            ]),
        });
    });

    it("marks malformed boolean frontmatter incomplete instead of silently changing behavior", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow", "Skill", "Subagent"], {
                ".claude/commands/bad-boolean.md": `---\nname: bad-boolean\ndescription: bad\nuser-invocable: 1\n---\nBody\n`,
                ".claude/skills/bad-boolean/SKILL.md": `---\nname: bad-boolean\ndescription: bad\ndisable-model-invocation: maybe\n---\nBody\n`,
                ".claude/agents/bad-boolean.md": `---\nname: bad-boolean\ndescription: bad\nbackground: []\n---\nBody\n`,
            }),
        );
        expect(result.candidates).toHaveLength(3);
        expect(result.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(
            result.candidates
                .flatMap((candidate) => candidate.diagnostics)
                .filter((diagnostic) => diagnostic.code === "claudecode.boolean_frontmatter_invalid"),
        ).toHaveLength(3);
        expect(result.candidates.find((candidate) => candidate.kind === "Workflow")?.typeData).toMatchObject({
            invocation: { userInvocable: true },
        });
        expect(result.candidates.find((candidate) => candidate.kind === "Skill")?.typeData).toMatchObject({
            invocation: { model: { mode: "model_decision" } },
        });
        expect(result.candidates.find((candidate) => candidate.kind === "Subagent")?.typeData).toMatchObject({
            execution: { scheduling: { mode: "agent_runtime_default" } },
        });
    });

    it("reads global config sources without descending into project-only paths", async () => {
        const root = configRoot();
        const result = await claudecodeProvider.read(
            readInput(root, ["Guidance", "Rule", "Workflow", "Skill", "Subagent"], {
                "CLAUDE.md": "# Global guidance\n",
                "rules/global.md": "Global rule\n",
                "commands/global.md": `---\nname: global\ndescription: Global command\nuser-invocable: false\ndisable-model-invocation: true\n---\nDo it.\n`,
                "skills/global/SKILL.md": `---\nname: global-skill\ndescription: Global skill\nuser-invocable: false\ndisable-model-invocation: true\n---\nHelp.\n`,
                "agents/global.md": `---\nname: global-agent\ndescription: Global agent\ntools: []\nmemory: user\n---\nHelp.\n`,
                "projects/should-not-scan/CLAUDE.md": "# Wrong boundary\n",
            }),
        );
        expect(result.candidates.map((candidate) => candidate.kind).sort()).toEqual(
            ["Guidance", "Rule", "Workflow", "Skill", "Subagent"].sort(),
        );
        expect(result.candidates.find((candidate) => candidate.kind === "Rule")?.typeData).toMatchObject({ name: "global" });
        expect(result.candidates.some((candidate) => candidate.displayName === "should-not-scan")).toBe(false);
        expect(result.candidates.find((candidate) => candidate.kind === "Skill")?.typeData).toMatchObject({
            invocation: {
                user: { mode: "not_directly_invocable" },
                model: { mode: "disabled" },
            },
            execution: { mode: "caller" },
        });
        expect(result.candidates.find((candidate) => candidate.kind === "Subagent")?.typeData).toMatchObject({
            tools: { availability: { base: { mode: "none" } } },
            memory: { mode: "persistent", storageScope: "global" },
        });
    });

    it("reads user-global JavaScript Workflows as complete config-root graphs", async () => {
        const result = await claudecodeProvider.read(
            readInput(configRoot(), ["Workflow"], {
                "workflows/standalone.js": {
                    text: `export const meta = { name: "global-standalone" };\nexport default () => "standalone";\n`,
                    executable: true,
                },
                "workflows/bundle/workflow.js": {
                    text: `export const meta = { name: "global-bundle" };\nexport default () => "bundle";\n`,
                    executable: true,
                },
                "workflows/bundle/resources/marker.txt": "global resource\n",
                "workflows/bundle/resources/marker.bin": new Uint8Array([0, 1, 255]),
            }),
        );

        expect(result.diagnostics).toEqual([]);
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    scope: "global",
                    projectRootPath: "",
                    displayName: "global-bundle",
                    status: "complete",
                    nativeRepresentation: {
                        representationSource: "separate_files",
                        dialectId: "claudecode-js-workflow-v1",
                        files: [
                            expect.objectContaining({ relativePath: "workflows/bundle/resources/marker.bin" }),
                            expect.objectContaining({ relativePath: "workflows/bundle/resources/marker.txt" }),
                            expect.objectContaining({ relativePath: "workflows/bundle/workflow.js", executable: true }),
                        ],
                    },
                }),
                expect.objectContaining({
                    scope: "global",
                    projectRootPath: "",
                    displayName: "global-standalone",
                    status: "complete",
                    nativeRepresentation: {
                        representationSource: "separate_files",
                        dialectId: "claudecode-js-workflow-v1",
                        files: [expect.objectContaining({ relativePath: "workflows/standalone.js", executable: true })],
                    },
                }),
            ]),
        );
        expect(
            result.candidates
                .find((candidate) => candidate.displayName === "global-bundle")
                ?.files.map((file) => [file.logicalPath, file.contentKind]),
        ).toEqual([
            ["resources/marker.bin", "binary"],
            ["resources/marker.txt", "text"],
            ["workflow.js", "text"],
        ]);
    });

    it("preserves Workflow deny precedence and fallback metadata without claiming equivalence", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow"], {
                ".claude/commands/plain.md": `---\nallowed-tools: [Read, Write]\ndisallowed-tools: [Write]\n---\n/plain $ARGUMENTS\n`,
                ".claude/workflows/no-meta.js": "export default () => 1;\n",
                ".claude/workflows/single.js": `export const meta = { name: 'single', description: 'single quoted' };\n`,
            }),
        );
        const plain = result.candidates.find((candidate) => candidate.displayName === "plain");
        expect(plain).toMatchObject({
            status: "complete",
            typeData: {
                implementation: {
                    execution: { mode: "caller", agent: { mode: "agent_runtime_default" } },
                    toolPolicy: {
                        preapproved: [{ selector: "Read" }],
                        denied: [{ selector: "Write" }],
                    },
                },
            },
        });
        expect(plain?.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "claudecode.workflow_description_missing" }),
                expect.objectContaining({ code: "claudecode.workflow_tool_overlap" }),
            ]),
        );
        expect(result.candidates.find((candidate) => candidate.displayName === "no-meta")).toMatchObject({
            status: "incomplete",
            typeData: { implementation: { kind: "executable" } },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "single")).toMatchObject({
            status: "complete",
            displayDescription: "single quoted",
        });
    });

    it("keeps standalone JavaScript Workflows separate and fails one ambiguous directory graph closed", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow"], {
                ".claude/workflows/alpha.js": `export const meta = { name: "alpha" };\n`,
                ".claude/workflows/beta.js": `export const meta = { name: "beta" };\n`,
                ".claude/workflows/bundle/one.js": `export const meta = { name: "one" };\n`,
                ".claude/workflows/bundle/two.js": `export const meta = { name: "two" };\n`,
                ".claude/workflows/bundle/resources/marker.bin": new Uint8Array([0, 1, 255]),
            }),
        );

        expect(
            result.candidates.filter((candidate) => candidate.status === "complete").map((candidate) => candidate.displayName),
        ).toEqual(["alpha", "beta"]);
        const incomplete = result.candidates.filter((candidate) => candidate.status === "incomplete");
        expect(incomplete).toEqual([
            expect.objectContaining({
                displayName: "one",
                diagnostics: [expect.objectContaining({ code: "claudecode.workflow_js_graph_ambiguous" })],
            }),
        ]);
        expect(incomplete[0]?.nativeRepresentation).toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({ relativePath: ".claude/workflows/bundle/resources/marker.bin" }),
            ]),
        });
    });

    it("fails a nested overlapping JavaScript Workflow graph as one owned candidate", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow"], {
                ".claude/workflows/bundle/z-main.js": `export const meta = { name: "outer" };\n`,
                ".claude/workflows/bundle/nested/a-child.js": `export const meta = { name: "nested" };\n`,
                ".claude/workflows/bundle/nested/resource.bin": new Uint8Array([0, 1, 255]),
            }),
        );

        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayName: "outer",
                status: "incomplete",
                diagnostics: [expect.objectContaining({ code: "claudecode.workflow_js_graph_ambiguous" })],
            }),
        ]);
        expect(
            (result.sourceParseReports[0]?.readEntryDispositions ?? []).every(
                (item) => item.disposition === "ignored" || item.candidateIds.length <= 1,
            ),
        ).toBe(true);
    });

    it("keeps unknown selectors raw while classifying known model/effort tiers", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Skill", "Subagent"], {
                ".claude/skills/tier/SKILL.md": `---\nname: tier\ndescription: tiers\ncontext: fork\nagent: general-purpose\nmodel: haiku\neffort: medium\narguments: [one, one, two]\ndisallowed-tools: [Write]\n---\nBody.\n`,
                ".claude/agents/tier.md": `---\nname: tier-agent\ndescription: tiers\ntools: ['*']\ndisallowedTools: [Write]\npermissionMode: bypassPermissions\nmemory: local\nmodel: future-model\neffort: low\n---\nBody.\n`,
            }),
        );
        const skill = result.candidates.find((candidate) => candidate.kind === "Skill");
        expect(skill).toMatchObject({
            status: "complete",
            typeData: {
                invocation: { argumentNames: ["one", "two"] },
                execution: {
                    mode: "isolated",
                    model: { mode: "selected", relativeTier: 1 },
                    effort: { mode: "selected", relativeTier: 4 },
                },
            },
        });
        const agent = result.candidates.find((candidate) => candidate.kind === "Subagent");
        expect(agent?.typeData).toMatchObject({
            tools: { availability: { base: { mode: "inherit_available" } } },
            memory: { mode: "persistent", storageScope: "project_local" },
            execution: {
                permission: { mode: "selected", effect: "bypass_permission_checks" },
                model: { mode: "selected", relativeTier: -1 },
                effort: { mode: "selected", relativeTier: 1 },
            },
        });
    });

    it("maps each known Subagent permission mode and persistent-memory scope explicitly", async () => {
        const permissionModes = [
            ["default", "interactive", "user"],
            ["manual", "interactive", "project"],
            ["acceptEdits", "auto_approve_selected_operations", "local"],
            ["dontAsk", "auto_deny_unapproved", "user"],
            ["auto", "classifier_mediated", "project"],
        ] as const;
        const files: Record<string, FixtureValue> = {};
        for (const [mode, _effect, memory] of permissionModes) {
            files[`.claude/agents/${mode}.md`] =
                `---\nname: ${mode}\ndescription: ${mode}\ntools: [Read]\npermissionMode: ${mode}\nmemory: ${memory}\nbackground: false\nmodel: sonnet\neffort: xhigh\n---\nBody\n`;
        }
        files[".claude/agents/inherit.md"] = `---\nname: inherit\ndescription: inherit\n---\nBody\n`;
        const result = await claudecodeProvider.read(readInput(projectRoot(), ["Subagent"], files));
        expect(result.candidates).toHaveLength(6);
        for (const [mode, effect] of permissionModes) {
            expect(result.candidates.find((candidate) => candidate.displayName === mode)?.typeData).toMatchObject({
                tools: { availability: { base: { mode: "allowlist" } } },
                execution: {
                    permission: { mode: "selected", effect },
                    scheduling: { mode: "agent_runtime_default" },
                    model: { mode: "selected", relativeTier: 5 },
                    effort: { mode: "selected", relativeTier: 10 },
                },
            });
        }
        expect(result.candidates.find((candidate) => candidate.displayName === "inherit")?.typeData).toMatchObject({
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
        });
    });

    it("classifies include/link references and preserves each Skill resource media type", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Guidance", "Skill"], {
                "CLAUDE.md": `email@example.com\n@./relative.md#part\n@~/global.md\n@/absolute.md\n@name\\ with\\ spaces.md\n\`\`\`\n@inside-fence.md\n\`\`\`\n`,
                ".claude/skills/media/SKILL.md": `---\nname: media\ndescription: resources\n---\n[resolved](./docs/../docs/readme.md) [external](https://example.com/x) [absolute](/docs/readme.md) [home](~/docs/readme.md) [missing](missing.md) [bad](../escape.md) []()\n`,
                ".claude/skills/media/docs/readme.md": "[self](readme.md)",
                ".claude/skills/media/data.json": "{}",
                ".claude/skills/media/data.JSONC": "{}",
                ".claude/skills/media/code.js": "export {};",
                ".claude/skills/media/code.ts": "export {};",
                ".claude/skills/media/notes.txt": "notes",
                ".claude/skills/media/value.custom": "custom",
            }),
        );
        const guidance = result.candidates.find((candidate) => candidate.kind === "Guidance");
        expect(guidance?.files[0]?.references.map((reference) => reference.resolution)).toEqual([
            "unresolved",
            "external",
            "external",
            "unresolved",
        ]);
        const skill = result.candidates.find((candidate) => candidate.kind === "Skill");
        expect(skill?.files.map((file) => [file.logicalPath, file.mediaType])).toEqual([
            ["SKILL.md", "text/markdown"],
            ["code.js", "text/javascript"],
            ["code.ts", "text/typescript"],
            ["data.JSONC", "application/json"],
            ["data.json", "application/json"],
            ["docs/readme.md", "text/markdown"],
            ["notes.txt", "text/plain"],
            ["value.custom", "application/octet-stream"],
        ]);
        expect(skill?.files[0]?.references.map((reference) => reference.resolution)).toEqual([
            "resolved_version_file",
            "external",
            "external",
            "external",
            "unresolved",
            "unresolved",
        ]);
        expect(skill?.files.find((file) => file.logicalPath === "docs/readme.md")?.references).toEqual([
            expect.objectContaining({
                rawTarget: "readme.md",
                resolution: "resolved_version_file",
                targetLogicalPath: "docs/readme.md",
            }),
        ]);
    });

    it("treats a nested SKILL.md as a parent Skill resource, not a second declaration", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Skill"], {
                ".claude/skills/parent/SKILL.md": `---\nname: parent\ndescription: Parent Skill\n---\nUse [details](docs/SKILL.md).\n`,
                ".claude/skills/parent/docs/SKILL.md": `---\nname: nested\ndescription: Resource only\n---\nReference material.\n`,
            }),
        );
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
            displayName: "parent",
            files: [
                expect.objectContaining({ logicalPath: "SKILL.md", role: "entry" }),
                expect.objectContaining({ logicalPath: "docs/SKILL.md", role: "resource" }),
            ],
        });
        expect(result.candidates[0]?.files[0]?.references).toEqual([
            expect.objectContaining({
                rawTarget: "docs/SKILL.md",
                resolution: "resolved_version_file",
                targetLogicalPath: "docs/SKILL.md",
            }),
        ]);
    });

    it("handles nested command names and malformed JavaScript metadata without executing code", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Workflow"], {
                ".claude/commands/team/SKILL.md": `---\ndescription: Team command\n---\n/team\n`,
                ".claude/workflows/nested.js": `export const metadata = {}; export const meta = { nested: { name: "wrong", value: "}" }, /* } */ name: "nested\\"name", description: 4 };`,
                ".claude/workflows/commented.js": `// export const meta = { name: "fake" };\nexport default () => 1;`,
                ".claude/workflows/duplicate.js": `export const meta = { name: "first", name: "second" };`,
                ".claude/workflows/after-string.js": `const sample = "export const meta = { name: 'fake' }"; export const meta = { name: "after-string", description: "real" };`,
                ".claude/workflows/after-block.js": `/* export const meta = { name: "fake" }; */\nexport const meta = { /* nested { } */ "name": "after-block", 'description': 'quoted' };`,
                ".claude/workflows/complex.js": `export const meta = { phases: [{ run: () => ({ value: "}" }) }], // ignored }\nname: "complex", description: "safe" };`,
                ".claude/workflows/after-template.js":
                    "const sample = `export const meta = { name: \\\"fake\\\" }`; export const meta = { name: 'after-template' };",
                ".claude/workflows/no-brace.js": "export const meta = 4;",
                ".claude/workflows/unclosed.js": 'export const meta = { name: "bad";',
                ".claude/workflows/unowned.txt": "not a Workflow declaration",
            }),
        );
        expect(result.candidates.find((candidate) => candidate.displayName === "team")?.status).toBe("complete");
        expect(result.candidates.find((candidate) => candidate.displayName === 'nested"name')).toMatchObject({
            status: "complete",
            displayDescription: "",
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "commented")?.status).toBe("incomplete");
        expect(result.candidates.find((candidate) => candidate.displayName === "duplicate")?.status).toBe("incomplete");
        expect(result.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "after-string",
                    displayDescription: "real",
                    status: "complete",
                }),
                expect.objectContaining({
                    displayName: "after-block",
                    displayDescription: "quoted",
                    status: "complete",
                }),
                expect.objectContaining({
                    displayName: "complex",
                    displayDescription: "safe",
                    status: "complete",
                }),
                expect.objectContaining({ displayName: "after-template", status: "complete" }),
            ]),
        );
        expect(result.candidates.filter((candidate) => candidate.status === "incomplete")).toHaveLength(4);
        expect(result.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "unowned_workflow_resource" }),
        );
    });

    it("surfaces Memory taxonomy conflicts and malformed topics as incomplete", async () => {
        const result = await claudecodeProvider.read(
            readInput(memoryRoot(), ["Memory"], {
                "conflict.md": `---\nname: Conflict\ndescription: conflict\ntype: user\nmetadata:\n  type: project\n---\nBody\n`,
                "missing.md": `---\nname: Missing\n---\nBody\n`,
                "plain.md": "plain body",
                "empty.md": `---\nname: Empty\ndescription: empty\ntype: feedback\n---\n`,
            }),
        );
        expect(result.candidates).toHaveLength(4);
        expect(result.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(result.candidates.flatMap((candidate) => candidate.diagnostics).map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "claudecode.memory_type_conflict",
                "claudecode.memory_type_missing_or_unknown",
                "claudecode.memory_metadata_incomplete",
            ]),
        );
    });

    it("rejects non-UTF-8 declarations with diagnostics and keeps empty Guidance empty", async () => {
        const project = await claudecodeProvider.read(
            readInput(projectRoot(), ["Guidance", "Rule", "Workflow", "Skill", "Subagent"], {
                "CLAUDE.md": "",
                "CLAUDE.local.md": new Uint8Array([0xff]),
                ".claude/rules/binary.md": new Uint8Array([0xff]),
                ".claude/commands/binary.md": new Uint8Array([0xff]),
                ".claude/skills/binary/SKILL.md": new Uint8Array([0xff]),
                ".claude/agents/binary.md": new Uint8Array([0xff]),
            }),
        );
        expect(project.candidates).toEqual([]);
        expect(project.diagnostics.filter((item) => item.code === "claudecode.declaration_not_utf8")).toHaveLength(5);
        expect(project.sourceParseReports[0]?.status).toBe("skipped_ignored_source");
        expect(
            project.sourceParseReports[0]?.readEntryDispositions.filter(
                (item) => item.disposition === "ignored" && item.reasonCode === "declaration_not_utf8",
            ),
        ).toHaveLength(6);

        const memory = await claudecodeProvider.read(
            readInput(memoryRoot(), ["Memory"], {
                "MEMORY.md": new Uint8Array([0xff]),
                "topic.md": new Uint8Array([0xff]),
            }),
        );
        expect(memory.candidates).toEqual([]);
        expect(memory.diagnostics.filter((item) => item.code === "claudecode.declaration_not_utf8")).toHaveLength(2);
        expect(memory.sourceParseReports[0]?.status).toBe("skipped_ignored_source");
    });

    it("binds Memory catalog hints by exact relative path and ignores nested catalogs", async () => {
        const result = await claudecodeProvider.read(
            readInput(memoryRoot(), ["Memory"], {
                "MEMORY.md": "# Index\n- [Root](./topic.md) — root hint\n",
                "topic.md": `---\nname: Root\ndescription: root\ntype: project\n---\nRoot body\n`,
                "nested/topic.md": `---\nname: Nested\ndescription: nested\ntype: project\n---\nNested body\n`,
                "nested/MEMORY.md": "# Not a second catalog\n",
            }),
        );
        expect(result.candidates.filter((candidate) => candidate.typeData.entityRole === "catalog")).toHaveLength(1);
        expect(result.candidates.find((candidate) => candidate.typeData.entityRole === "catalog")).toMatchObject({
            memoryCatalogMemberBindingInputs: [{ rawTarget: "topic.md", routingTitle: "Root", routingHint: "root hint" }],
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "Root")?.diagnostics).not.toContainEqual(
            expect.objectContaining({ code: "claudecode.memory_topic_unlinked" }),
        );
        expect(result.candidates.find((candidate) => candidate.displayName === "Nested")?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "claudecode.memory_topic_unlinked" }),
        );
        expect(result.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({
                disposition: "ignored",
                reasonCode: "nested_memory_catalog",
            }),
        );
    });

    it("keeps a Memory Catalog incomplete when member identity is malformed or duplicated", async () => {
        const result = await claudecodeProvider.read(
            readInput(memoryRoot(), ["Memory"], {
                "MEMORY.md": [
                    "# Index",
                    "- [Root](topic.md) — first",
                    "- [Duplicate](./topic.md) — second",
                    "- [](../outside.md) — invalid",
                ].join("\n"),
                "topic.md": `---\nname: Root\ndescription: root\ntype: project\n---\nRoot body\n`,
            }),
        );
        const catalog = result.candidates.find((candidate) => candidate.typeData.entityRole === "catalog");
        expect(catalog).toMatchObject({
            status: "incomplete",
            assetCandidateStatus: "incomplete",
            diagnostics: [
                expect.objectContaining({ code: "claudecode.memory_catalog_member_duplicate" }),
                expect.objectContaining({ code: "claudecode.memory_catalog_member_invalid" }),
            ],
        });
        expect(catalog).not.toHaveProperty("memoryCatalogMemberBindingInputs");
    });

    it("marks unresolved nested Subagent selectors as incomplete callable dependencies", async () => {
        const result = await claudecodeProvider.read(
            readInput(projectRoot(), ["Subagent"], {
                ".claude/agents/nested.md": `---\nname: nested\ndescription: nested\ntools: [Agent(worker), Task(other)]\n---\nBody\n`,
            }),
        );
        expect(result.candidates[0]).toMatchObject({
            status: "incomplete",
            diagnostics: [expect.objectContaining({ code: "claudecode.subagent_nested_binding_pending" })],
        });
    });
});
