import type { AdapterAssetSourceCapability, AdapterProviderReadInput, AssetKind, Sha256Digest, SourceRoot } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    type AdapterFixtureValue,
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindRequiredAdapterCapability,
    bindUserSelectedReadInput,
    readAccessFailed as failed,
    failingReadAccess,
    fixtureSourceRoot,
    fixtureFrontmatter as fm,
    nonDirectoryRootReadAccess,
    unexpectedReadAccess,
} from "../../../test-support";
import { parseAntigravityFrontmatter } from "../src/antigravity-frontmatter";
import { antigravityProvider } from "../src/antigravity-provider";
import {
    frontmatterDiagnostics,
    isFlatSkillEntry,
    isFolderSkillEntry,
    parseAtReferences,
    parseMarkdownReferences,
    parseWorkflowReferences,
} from "../src/antigravity-source-read-foundation";
import { ANTIGRAVITY_ASSET_READER_REGISTRY } from "../src/antigravity-source-read-registry";

const DIGEST = `sha256:${"1".repeat(64)}` as Sha256Digest;
const observation = bindFixtureProbeObservation({
    adapterId: "ANTIGRAVITY",
    agentRuntimeId: "ANTIGRAVITY_CLI",
    versionText: "fixture",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});

describe("Antigravity source boundary and malformed-input conformance", () => {
    it("preserves Antigravity-specific reference and Skill-root grammar after common extraction", () => {
        expect(
            parseAtReferences("mail user@example.com\n @docs/file.md\n@/absolute.md\n@plain\n```\n@skip.md\n```").map((item) => [
                item.rawTarget,
                item.resolution,
            ]),
        ).toEqual([
            ["docs/file.md", "unresolved"],
            ["/absolute.md", "external"],
        ]);
        expect(
            parseWorkflowReferences("x/reject (/review) /run:fast / /run:fast\n```\n/skip\n```").map((item) => item.rawTarget),
        ).toEqual(["review", "run:fast"]);
        expect(parseMarkdownReferences("[unfinished", new Set(), "docs/readme.md")).toEqual([]);
        expect(parseMarkdownReferences("[x](unfinished", new Set(), "docs/readme.md")).toEqual([]);
        expect(
            parseMarkdownReferences(
                "[empty]() [resolved](../a.md) [external](https://example.com/a.md) [missing](missing.md)",
                new Set(["a.md"]),
                "docs/readme.md",
            ),
        ).toEqual([
            expect.objectContaining({
                rawTarget: "../a.md",
                resolution: "resolved_version_file",
                targetLogicalPath: "a.md",
            }),
            expect.objectContaining({
                rawTarget: "https://example.com/a.md",
                resolution: "external",
            }),
            expect.objectContaining({
                rawTarget: "missing.md",
                resolution: "unresolved",
            }),
        ]);
        expect(isFolderSkillEntry("other/demo/SKILL.md", [".agents/skills"])).toBe(false);
        expect(isFolderSkillEntry("demo/SKILL.md", [""])).toBe(true);
        expect(isFlatSkillEntry("other/demo.md", [".agents/skills"])).toBe(false);
        expect(isFlatSkillEntry("demo.md", [""])).toBe(true);
        expect(
            frontmatterDiagnostics(parseAntigravityFrontmatter("---\nname: demo\nbody"), "broken.md").map(
                (diagnostic) => diagnostic.code,
            ),
        ).toEqual(["antigravity.frontmatter_unclosed", "antigravity.frontmatter_unsupported"]);
    });

    it("registers one explicit reader or unsupported disposition for every AssetKind", () => {
        expect(Object.keys(ANTIGRAVITY_ASSET_READER_REGISTRY).sort()).toEqual([
            "Guidance",
            "Memory",
            "Rule",
            "Skill",
            "Subagent",
            "Workflow",
        ]);
        expect(Object.values(ANTIGRAVITY_ASSET_READER_REGISTRY).filter((row) => row.disposition === "reader")).toHaveLength(5);
        expect(ANTIGRAVITY_ASSET_READER_REGISTRY.Memory).toEqual({
            disposition: "unsupported",
            diagnosticCode: "antigravity.memory_source_unsupported",
            message: "Antigravity has no native Memory source contract",
        });
        expect("buildCandidates" in ANTIGRAVITY_ASSET_READER_REGISTRY.Memory).toBe(false);
    });

    it("honors the user-selected global/project scope and never treats it as an automatic probe root", async () => {
        const root = externalRoot();
        const capability = externalCapability("Guidance");
        const global = await antigravityProvider.read(
            userSelectedReadInput(root, capability, "global", "", { "nested/notes.md": "# Global external\n" }),
        );
        expect(global.candidates[0]).toMatchObject({ scope: "global", projectRootPath: "" });

        const project = await antigravityProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/project", { "nested/notes.md": "# Project external\n" }),
        );
        expect(project.candidates[0]).toMatchObject({ scope: "project", projectRootPath: "/fixture/project" });

        const automatic = rawReadInput(root, [capability], { "notes.md": "# must not be inferred\n" });
        const rejected = await antigravityProvider.read(automatic);
        expect(rejected.candidates).toEqual([]);
        expect(rejected.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity.source_scope_unresolved",
            }),
        );
    });

    it("reports unknown obligations, roots without obligations, and failed root resolution", async () => {
        const root = projectRoot();
        const capability = projectCapabilities(["Guidance"])[0];
        if (capability === undefined) throw new Error("missing Guidance capability");
        const input = rawReadInput(root, [capability], {});
        input.sourceReadObligations.push({
            sourceReadObligationId: "unknown",
            sourceRootId: "missing-root",
            sourceCapabilityFingerprint: DIGEST,
        });
        input.readAccess = failingReadAccess();
        const result = await antigravityProvider.read(input);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity.read_authority_unknown",
            }),
        );
        expect(result.sourceParseReports[0]).toMatchObject({ status: "empty", observedReadEntryIds: [] });

        const withoutObligations = await antigravityProvider.read(rawReadInput(root, [], {}));
        expect(withoutObligations.sourceParseReports).toEqual([
            expect.objectContaining({
                status: "deferred",
                diagnostics: [expect.objectContaining({ code: "antigravity.root_without_obligation" })],
            }),
        ]);
    });

    it("reports a non-directory source, list failure, and file read failure without candidates", async () => {
        const root = projectRoot();
        const nonDirectory = readInput(root, ["Guidance"], {});
        nonDirectory.readAccess = nonDirectoryRootReadAccess(root);
        const nonDirectoryResult = await antigravityProvider.read(nonDirectory);
        expect(nonDirectoryResult.sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
            diagnostics: [expect.objectContaining({ code: "antigravity.source_root_not_directory" })],
        });

        const listFailure = readInput(root, ["Guidance"], { "AGENTS.md": "# Guidance" });
        listFailure.readAccess = {
            ...listFailure.readAccess,
            async listDirectory() {
                return failed("list-failed", "not_found");
            },
        };
        expect((await antigravityProvider.read(listFailure)).sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
        });

        const readFailure = readInput(root, ["Guidance"], { "AGENTS.md": "# Guidance" });
        readFailure.readAccess = {
            ...readFailure.readAccess,
            async readFile() {
                return failed("read-failed", "not_found");
            },
        };
        const readFailureResult = await antigravityProvider.read(readFailure);
        expect(readFailureResult.candidates).toEqual([]);
        expect(readFailureResult.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "file_unreadable" }),
        );
    });

    it("ignores empty/non-UTF8 Guidance and extracts only references outside code fences", async () => {
        const result = await readProject(["Guidance"], {
            "AGENTS.md": new Uint8Array([0xff, 0xfe]),
            "GEMINI.md":
                "Read @docs/guide.md#part, @https://example.com/x. and @~/.config/x but ignore @word and @/ \n\t@tab.md\nx\r@cr.md\n```\n@hidden.md\n```\nmail@example.com\n",
            "ignored.md": "# ignored",
        });
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]?.files[0]?.references).toEqual([
            expect.objectContaining({ rawTarget: "docs/guide.md", resolution: "unresolved" }),
            expect.objectContaining({ rawTarget: "https://example.com/x.", resolution: "external" }),
            expect.objectContaining({ rawTarget: "~/.config/x", resolution: "external" }),
            expect.objectContaining({ rawTarget: "tab.md", resolution: "unresolved" }),
            expect.objectContaining({ rawTarget: "cr.md", resolution: "unresolved" }),
        ]);
        expect(result.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" }),
        );

        const empty = await readProject(["Guidance"], { "AGENTS.md": "  \n" });
        expect(empty.candidates).toEqual([]);
        expect(empty.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "empty_guidance_source" }),
        );

        const binary = await readProject(["Guidance"], { "AGENTS.md": new Uint8Array([0xff, 0xfe]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "antigravity.declaration_not_utf8" }));
    });

    it("classifies every Rule trigger conservatively and rejects malformed patterns", async () => {
        const oversized = "x".repeat(12_050);
        const result = await readProject(["Rule"], {
            ".agents/rules/always.md": fm("name: always\ndescription: Always\ntrigger: always", "Always body"),
            ".agents/rules/manual.md": fm("trigger: manual", "Manual body"),
            ".agents/rules/model.md": fm("trigger: model_decision\ndescription: Decide", "Model body"),
            ".agents/rules/path.md": fm("trigger: path\npaths: [src/**, test/**]\npattern: docs/**", "Path body"),
            ".agents/rules/bad-path.md": fm("trigger: glob\nglobs: [../secret, good/**]", "Bad path"),
            ".agents/rules/absolute-path.md": fm("trigger: glob\nglobs: [/secret]", "Absolute path"),
            ".agents/rules/backslash-path.md": fm("trigger: glob\nglobs: ['bad\\\\path']", "Backslash path"),
            ".agents/rules/dot-path.md": fm("trigger: glob\nglobs: [src/./file]", "Dot path"),
            ".agents/rules/empty-segment.md": fm("trigger: glob\nglobs: [src//file]", "Empty segment"),
            ".agents/rules/unknown.md": fm("trigger: future\nfuture: true", "Unknown"),
            ".agents/rules/missing.md": "Plain body",
            ".agents/rules/empty.md": fm("trigger: always_on", ""),
            ".agents/rules/large.md": fm("trigger: always_on", oversized),
            ".agents/rules/wrong-name-type.md": fm("name: [wrong]\ntrigger: always_on", "Wrong name"),
            ".agent/rules/alt.md": fm("trigger: always_on", "Alternate root"),
        });
        expect(result.candidates).toHaveLength(15);
        expect(result.candidates.find((item) => item.displayName === "always")?.status).toBe("complete");
        expect(result.candidates.find((item) => item.displayName === "path")?.typeData).toMatchObject({
            activation: { mode: "path", globs: ["src/**", "test/**", "docs/**"] },
        });
        expect(
            result.candidates
                .filter((item) => item.displayName !== "always" && item.displayName !== "large" && item.displayName !== "alt")
                .every((item) => item.status === "incomplete"),
        ).toBe(true);
        expect(result.candidates.find((item) => item.displayName === "large")?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity.rule_size_limit_exceeded", severity: "warning" }),
        );
        expect(result.candidates.flatMap((item) => item.diagnostics).map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "antigravity.rule_trigger_schema_unverified",
                "antigravity.rule_glob_invalid",
                "antigravity.rule_trigger_unknown",
                "antigravity.rule_trigger_missing",
                "antigravity.rule_body_missing",
                "antigravity.unknown_behavioral_frontmatter",
                "antigravity.frontmatter_string_field_invalid",
            ]),
        );
    });

    it("keeps Workflow invocation syntax as exact-dialect references and marks malformed declarations incomplete", async () => {
        const oversized = "z".repeat(12_050);
        const result = await readProject(["Workflow"], {
            ".agents/workflows/good.md": fm(
                "name: deploy\ndescription: Deploy safely",
                "Run /review and (/review) but not x/reject.\n```\n/hidden\n```\n/run:fast /run:fast",
            ),
            ".agents/workflows/no-description.md": fm("name: missing", "Body"),
            ".agents/workflows/no-body.md": fm("description: Empty", ""),
            ".agents/workflows/large.md": fm("description: Large", oversized),
            ".agents/workflows/unknown.md": fm("description: Future\npermission: unsafe", "Body"),
            ".agents/workflows/wrong-name-type.md": fm("name: [wrong]\ndescription: Typed", "Body"),
            ".agent/workflows/alt.md": fm("description: Alternate", "Alt body"),
        });
        const good = result.candidates.find((item) => item.displayName === "deploy");
        expect(good?.files[0]?.references).toEqual([
            expect.objectContaining({ rawTarget: "review" }),
            expect.objectContaining({ rawTarget: "run:fast" }),
        ]);
        expect(result.candidates.find((item) => item.displayName === "missing")?.status).toBe("incomplete");
        expect(result.candidates.find((item) => item.displayName === "no-body")?.status).toBe("incomplete");
        expect(result.candidates.find((item) => item.displayName === "large")?.status).toBe("complete");
        expect(result.candidates.flatMap((item) => item.diagnostics).map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "antigravity.workflow_description_missing",
                "antigravity.workflow_body_missing",
                "antigravity.workflow_size_limit_exceeded",
                "antigravity.unknown_behavioral_frontmatter",
                "antigravity.frontmatter_string_field_invalid",
            ]),
        );
    });

    it("reads folder and flat Skills from both project conventions while preserving resource semantics", async () => {
        const result = await readProject(["Skill"], {
            ".agents/skills/demo/SKILL.md": fm(
                "name: demo\ndescription: Demo\nlicense: MIT\ncompatibility: linux\nmetadata:\n  owner: oaam",
                "[nested](docs/a.md) [dot](./docs/a.md) [double](docs//a.md) [fold](docs/../docs/a.md) " +
                    "[parent](../outside.md) [escape](../../escape.md) [bad](bad\\\\path.md) " +
                    "[absolute](/tmp/x) [home](~/x) [unc](\\\\server\\share) " +
                    "[scheme](A1+-.x:thing) [invalid-scheme](a_:thing) [web](https://example.com/x)",
            ),
            ".agents/skills/demo/docs/a.md": "[up](../SKILL.md)",
            ".agents/skills/demo/code.ts": "export const value = 1;",
            ".agents/skills/demo/code.js": "export const value = 2;",
            ".agents/skills/demo/config.yaml": "enabled: true",
            ".agents/skills/demo/config.yml": "enabled: false",
            ".agents/skills/demo/notes.txt": "notes",
            ".agents/skills/demo/data.custom": "custom",
            ".agents/skills/demo/data.JSONC": "{}",
            ".agents/skills/demo/image.bin": new Uint8Array([0, 255, 1]),
            ".agents/skills/flat.md": fm("name: flat\ndescription: Flat", "Flat body"),
            ".agent/skills/alternate/SKILL.md": fm("name: alternate\ndescription: Alternate", "Alt body"),
            ".agents/skills/invalid/SKILL.md": fm("description: missing name", "Body"),
            ".agents/skills/nonutf/SKILL.md": new Uint8Array([0xff]),
            ".agents/skills/README.txt": "ignored",
        });
        expect(result.candidates.map((item) => item.displayName).sort()).toEqual(["alternate", "demo", "flat"]);
        const demo = result.candidates.find((item) => item.displayName === "demo");
        expect(demo?.files.map((file) => [file.logicalPath, file.contentKind, file.mediaType])).toEqual([
            ["SKILL.md", "text", "text/markdown"],
            ["code.js", "text", "text/javascript"],
            ["code.ts", "text", "text/typescript"],
            ["config.yaml", "text", "application/yaml"],
            ["config.yml", "text", "application/yaml"],
            ["data.JSONC", "text", "application/json"],
            ["data.custom", "text", "application/octet-stream"],
            ["docs/a.md", "text", "text/markdown"],
            ["image.bin", "binary", "application/octet-stream"],
            ["notes.txt", "text", "text/plain"],
        ]);
        expect(demo?.files[0]?.references).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ rawTarget: "docs/a.md", resolution: "resolved_version_file" }),
                expect.objectContaining({ rawTarget: "../outside.md", resolution: "unresolved" }),
                expect.objectContaining({ rawTarget: "https://example.com/x", resolution: "external" }),
            ]),
        );
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["antigravity.skill_required_content_missing", "antigravity.declaration_not_utf8"]),
        );
    });

    it("marks unsupported Skill metadata shapes incomplete without dropping the source bytes", async () => {
        const result = await readProject(["Skill"], {
            ".agents/skills/antigravity-re-internals/SKILL.md": fm(
                "name: antigravity-re-internals\ndescription: Antigravity internals\ntrigger: model_decision",
                "Body",
            ),
            ".agents/skills/future/SKILL.md": fm("name: future\ndescription: Future\nmetadata: text\nfuture: yes", "Body"),
            ".agents/skills/typed/SKILL.md": fm("name: typed\ndescription: Typed\nlicense: [MIT]\ncompatibility: 7", "Body"),
        });
        expect(result.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "antigravity-re-internals",
                    status: "incomplete",
                    diagnostics: [expect.objectContaining({ code: "antigravity.skill_trigger_frontmatter_unverified" })],
                }),
                expect.objectContaining({
                    displayName: "future",
                    status: "incomplete",
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: "antigravity.skill_metadata_invalid" }),
                        expect.objectContaining({ code: "antigravity.unknown_behavioral_frontmatter" }),
                    ]),
                }),
                expect.objectContaining({
                    displayName: "typed",
                    status: "incomplete",
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: "antigravity.frontmatter_string_field_invalid" }),
                    ]),
                }),
            ]),
        );
    });

    it("rejects executable Skills and unsafe Subagents as whole sources", async () => {
        const baseAgent = JSON.parse(subagentJson({})) as Record<string, unknown>;
        const nestedMcpAgent = JSON.parse(subagentJson({})) as {
            config: { customAgent: Record<string, unknown> };
        };
        nestedMcpAgent.config.customAgent.mcpServers = { local: { command: "unsafe" } };
        const result = await readProject(["Skill", "Subagent"], {
            ".agents/skills/hooked/SKILL.md": fm("name: hooked\ndescription: Hooked\nhooks: true", "Body"),
            ".agents/skills/hooked/resource.txt": "owned resource",
            ".agents/skills/shell/SKILL.md": fm("name: shell\ndescription: Shell\nshell: bash", "Body"),
            ".agents/agents/hooked/agent.json": JSON.stringify({ ...baseAgent, hooks: {} }),
            ".agents/agents/mcp/agent.json": JSON.stringify(nestedMcpAgent),
        });
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.filter((item) => item.code === "antigravity.skill_executable_source_rejected")).toHaveLength(2);
        expect(result.diagnostics.filter((item) => item.code === "antigravity.subagent_excluded_source")).toHaveLength(2);
        expect(
            result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "ignored").length,
        ).toBeGreaterThanOrEqual(4);
        expect(result.sourceParseReports[0]?.readEntryDispositions.filter((item) => item.disposition === "parsed")).toEqual([]);
    });

    it("maps Subagent variants without widening malformed permissions or context", async () => {
        const valid = subagentJson({
            hidden: false,
            tools: [" view_file ", "run_command", "view_file"],
            includeSections: [" user_rules ", "skills", "user_rules"],
        });
        const noTools = subagentJson({ hidden: true, tools: [], includeSections: undefined });
        const inherited = subagentJson({ hidden: undefined, tools: undefined, includeSections: undefined });
        const malformed = JSON.stringify({
            ...(JSON.parse(subagentJson({})) as Record<string, unknown>),
            hidden: "yes",
            future: true,
            config: {
                future: true,
                customAgent: {
                    systemPromptSections: [
                        { title: "ok", content: "body" },
                        { title: 2, content: "bad" },
                    ],
                    toolNames: ["read", 1],
                    future: true,
                    systemPromptConfig: { includeSections: [], future: true },
                },
            },
        });
        const result = await readProject(["Subagent"], {
            ".agents/agents/visible/agent.json": valid,
            ".agents/agents/hidden.json": noTools,
            ".agent/agents/inherited/agent.json": inherited,
            ".agents/agents/malformed/agent.json": malformed,
            ".agents/agents/bad-prompt-config/agent.json": JSON.stringify({
                ...(JSON.parse(subagentJson({})) as Record<string, unknown>),
                config: {
                    customAgent: {
                        systemPromptSections: [{ title: "ok", content: "body" }],
                        systemPromptConfig: "invalid",
                    },
                },
            }),
            ".agents/agents/bad-json/agent.json": "{",
            ".agents/agents/not-object.json": "[]",
            ".agents/agents/missing/agent.json": JSON.stringify({ name: "missing", description: "missing" }),
            ".agents/agents/deep/nested/agent.json": subagentJson({}),
        });
        expect(result.candidates.map((item) => item.displayName).sort()).toEqual([
            "fixture-agent",
            "fixture-agent",
            "fixture-agent",
            "fixture-agent",
            "fixture-agent",
        ]);
        const visible = result.candidates.find(
            (item) =>
                item.status === "complete" && "presentation" in item.typeData && item.typeData.presentation.listing === "visible",
        );
        expect(visible?.typeData).toMatchObject({
            promptContextPolicy: { mode: "selected", selectors: ["user_rules", "skills"] },
            tools: { availability: { base: { mode: "allowlist", allowed: expect.any(Array) } } },
        });
        const hidden = result.candidates.find(
            (item) =>
                item.status === "complete" && "presentation" in item.typeData && item.typeData.presentation.listing === "hidden",
        );
        expect(hidden?.typeData).toMatchObject({ tools: { availability: { base: { mode: "none" } } } });
        expect(result.candidates.find((item) => item.status === "incomplete")?.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "antigravity.subagent_field_invalid",
                "antigravity.subagent_empty_context_selection",
                "antigravity.subagent_unknown_behavior_field",
                "antigravity.subagent_section_invalid",
            ]),
        );
        expect(
            result.candidates.some((item) =>
                item.diagnostics.some(
                    (diagnostic) =>
                        diagnostic.code === "antigravity.subagent_field_invalid" && diagnostic.path.includes("bad-prompt-config"),
                ),
            ),
        ).toBe(true);
        expect(result.diagnostics.filter((item) => item.code === "antigravity.subagent_required_content_missing")).toHaveLength(
            3,
        );
    });

    it("rejects non-UTF8 Subagent declarations and supports config-root flat/folder JSON", async () => {
        const root = familyRoot();
        const result = await readRoot(root, ["Subagent"], {
            "config/agents/flat.json": subagentJson({}),
            "config/agents/folder/agent.json": subagentJson({ hidden: true }),
            "config/agents/folder/ignored.json": subagentJson({}),
            "config/agents/binary/agent.json": new Uint8Array([0xff]),
        });
        expect(result.candidates).toHaveLength(2);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "antigravity.declaration_not_utf8" }));
    });

    it("reads current Markdown Subagents from project and config flat/folder roots without swallowing unsafe dependencies", async () => {
        const project = await readProject(["Subagent"], {
            ".agents/agents/flat.md": fm(
                [
                    "name: project-flat",
                    "description: Project flat",
                    "subagent: true",
                    'tools: ["view_file"]',
                    "mainAgent: false",
                    "model: flash",
                    "commandExecutionPolicy: auto",
                    "hidden: false",
                ].join("\n"),
                "Review the project.",
            ),
            ".agent/agents/folder/agent.md": fm(
                "name: project-folder\ndescription: Project folder\nsubagent: true\ntools: []\nmainAgent: true",
                "Audit the project.",
            ),
            ".agents/agents/not-subagent.md": fm(
                "name: main-only\ndescription: Main only\nsubagent: false",
                "Act as the main agent.",
            ),
            ".agents/agents/skill-bound.md": fm(
                'name: skill-bound\ndescription: Skill bound\nskills: ["review"]',
                "Use an unresolved skill.",
            ),
            ".agents/agents/mcp.md": fm('name: mcp\ndescription: MCP\nmcpServers: ["local"]', "Use MCP."),
            ".agents/agents/deep/nested/agent.md": fm("name: deep\ndescription: Deep", "Ignore deep declarations."),
        });
        expect(project.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "project-flat",
                    scope: "project",
                    status: "complete",
                    assetCandidateStatus: "importable",
                    nativeRepresentation: expect.objectContaining({ dialectId: "antigravity-subagent-markdown-v1" }),
                    typeData: expect.objectContaining({
                        directInvocation: { mode: "delegated_only" },
                        execution: expect.objectContaining({
                            model: expect.objectContaining({ selector: "flash", relativeTier: 1 }),
                            permission: expect.objectContaining({ selector: "auto", effect: "classifier_mediated" }),
                        }),
                    }),
                }),
                expect.objectContaining({
                    displayName: "project-folder",
                    scope: "project",
                    status: "complete",
                    typeData: expect.objectContaining({
                        directInvocation: { mode: "user_selectable", initialPrompt: { mode: "none" } },
                        tools: expect.objectContaining({ availability: { base: { mode: "none" }, unavailable: [] } }),
                    }),
                }),
                expect.objectContaining({
                    displayName: "skill-bound",
                    status: "incomplete",
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: "antigravity.subagent_skill_binding_pending" }),
                    ]),
                }),
            ]),
        );
        expect(project.candidates.map((candidate) => candidate.displayName)).not.toContain("main-only");
        expect(project.candidates.map((candidate) => candidate.displayName)).not.toContain("mcp");
        expect(project.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "antigravity.subagent_markdown_not_delegation_capable" }),
                expect.objectContaining({ code: "antigravity.subagent_markdown_excluded_dependency" }),
            ]),
        );

        const global = await readRoot(familyRoot(), ["Subagent"], {
            "config/agents/global.md": fm("name: global-flat\ndescription: Global flat\nsubagent: true", "Global body."),
            "config/agents/folder/agent.md": fm(
                "name: global-folder\ndescription: Global folder\nsubagent: true",
                "Global folder body.",
            ),
            "config/agents/folder/ignored.md": fm("name: ignored\ndescription: Ignored", "Ignored sibling."),
        });
        expect(global.candidates.map((candidate) => candidate.displayName).sort()).toEqual(["global-flat", "global-folder"]);
        expect(global.candidates.every((candidate) => candidate.scope === "global")).toBe(true);
    });

    it("returns a typed failure when a caller tries to read the declared unsupported Memory row", async () => {
        const memory = requiredCapability((row) => row.agentRuntimeId === "ANTIGRAVITY_CLI" && row.assetKind === "Memory");
        const result = await antigravityProvider.read(rawReadInput(projectRoot(), [memory], {}));
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity.memory_source_unsupported",
            }),
        );
        expect(result.sourceParseReports).toEqual([
            expect.objectContaining({
                status: "unsupported",
                sourceReadObligationIds: ["obligation-Memory-0"],
                diagnostics: [expect.objectContaining({ code: "antigravity.memory_source_unsupported" })],
            }),
        ]);
    });

    it("keeps the legacy App-private Skill root report-only before invoking read access", async () => {
        const root = projectRoot();
        const capability = requiredCapability(
            (row) =>
                row.agentRuntimeId === "ANTIGRAVITY_APP" &&
                row.assetKind === "Skill" &&
                row.rootRole === "source" &&
                row.sourceDomain === "agent_runtime_private" &&
                row.readPolicy === "report_only",
        );
        const input = rawReadInput(root, [capability], { "legacy/SKILL.md": "# must not be read\n" });
        let readAccessCalls = 0;
        input.readAccess = unexpectedReadAccess(() => {
            readAccessCalls += 1;
        });

        const result = await antigravityProvider.read(input);

        expect(readAccessCalls).toBe(0);
        expect(result.candidates).toEqual([]);
        expect(result.sourceParseReports).toEqual([
            expect.objectContaining({
                status: "deferred",
                observedReadEntryIds: [],
                readEntryDispositions: [],
                diagnostics: [
                    expect.objectContaining({
                        code: "antigravity.source_capability_not_callable",
                    }),
                ],
            }),
        ]);
    });
});

type FixtureValue = AdapterFixtureValue;

function subagentJson(input: { hidden?: boolean; tools?: string[]; includeSections?: string[] }): string {
    return JSON.stringify({
        name: "fixture-agent",
        description: "Fixture agent",
        ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
        config: {
            customAgent: {
                systemPromptSections: [{ title: "Agent System Instructions", content: "Act safely." }],
                ...(input.tools === undefined ? {} : { toolNames: input.tools }),
                ...(input.includeSections === undefined
                    ? {}
                    : { systemPromptConfig: { includeSections: input.includeSections } }),
            },
        },
    });
}

async function readProject(kinds: AssetKind[], files: Record<string, FixtureValue>) {
    return readRoot(projectRoot(), kinds, files);
}

async function readRoot(root: SourceRoot, kinds: AssetKind[], files: Record<string, FixtureValue>) {
    return antigravityProvider.read(readInput(root, kinds, files));
}

function readInput(root: SourceRoot, kinds: AssetKind[], files: Record<string, FixtureValue>): AdapterProviderReadInput {
    const capabilities =
        root.rootRole === "config"
            ? configCapabilities(kinds)
            : root.rootRole === "source" && root.sourceDomain === "agent_runtime_private"
              ? privateSkillCapabilities()
              : projectCapabilities(kinds);
    return rawReadInput(root, capabilities, files);
}

const rawReadInput = bindFixtureProviderReadInput({
    digest: DIGEST,
    observation,
    resolveEntries: false,
    obligationId: (capability, index) => `obligation-${capability.assetKind}-${index}`,
});

const userSelectedReadInput = bindUserSelectedReadInput(rawReadInput);

function projectCapabilities(kinds: AssetKind[]): AdapterAssetSourceCapability[] {
    return kinds.map((kind) =>
        requiredCapability(
            (row) =>
                row.agentRuntimeId === "ANTIGRAVITY_CLI" &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "project_actual" &&
                row.sourceDomain === "project_root" &&
                row.readPolicy === "auto_read",
        ),
    );
}

function configCapabilities(kinds: AssetKind[]): AdapterAssetSourceCapability[] {
    return kinds.map((kind) =>
        requiredCapability(
            (row) =>
                row.agentRuntimeId === "ANTIGRAVITY_CLI" &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "config" &&
                row.sourceDomain === "family_shared" &&
                row.readPolicy === "auto_read",
        ),
    );
}

function privateSkillCapabilities(): AdapterAssetSourceCapability[] {
    return [
        requiredCapability(
            (row) =>
                row.agentRuntimeId === "ANTIGRAVITY_CLI" &&
                row.assetKind === "Skill" &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "source" &&
                row.sourceDomain === "agent_runtime_private" &&
                row.readPolicy === "auto_read",
        ),
    ];
}

function externalCapability(kind: Exclude<AssetKind, "Memory">): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === "ANTIGRAVITY_CLI" &&
            row.assetKind === kind &&
            row.entrySupportStatus === "supported" &&
            row.rootLocatorKind === "user_provided_path" &&
            row.sourceDomain === "external_managed" &&
            row.readPolicy === "user_selected_root_only",
    );
}

const requiredCapability = bindRequiredAdapterCapability(antigravityProvider, "missing Antigravity fixture capability");

function projectRoot(): SourceRoot {
    return sourceRoot("root-project", "/fixture/project", "project_actual", "project_root", "project_registry_entry");
}

function familyRoot(): SourceRoot {
    return sourceRoot("root-family", "/fixture/.gemini", "config", "family_shared", "runtime_known_rule");
}

function externalRoot(): SourceRoot {
    return sourceRoot("root-external", "/fixture/external", "source", "external_managed", "user_provided_path");
}

function sourceRoot(
    sourceRootId: string,
    rootPath: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"],
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path: rootPath,
        rootRole,
        sourceDomain,
        locatorKind,
        locatorKey: sourceRootId,
        evidenceLevel: "agent_runtime_verified",
    });
}
