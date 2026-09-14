import { describe, expect, it } from "vitest";
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_SOURCE_READ } from "../src/opencode-source-read";
import { OPENCODE_ASSET_READER_REGISTRY } from "../src/opencode-source-read-registry";
import {
    compareHandle,
    containsShellSubstitution,
    declarationName,
    ignoredDisposition,
    parseOpenCodeAtReferenceTokens,
} from "../src/opencode-source-read-foundation";
import {
    DIGEST,
    configRoot,
    externalCapability,
    externalRoot,
    failingReadAccess,
    failed,
    fm,
    projectCapabilities,
    projectRoot,
    rawReadInput,
    readInput,
    readProject,
    requiredCapability,
    sourceRoot,
    succeeded,
    userSelectedReadInput,
} from "./opencode-source-test-fixtures";

describe("OpenCode source boundary and malformed-input conformance", () => {
    it("keeps token, unterminated shell marker, fallback-name, and disposition utilities deterministic", () => {
        expect(parseOpenCodeAtReferenceTokens("mail@example.com `@hidden.md` @visible.md")).toEqual(["visible.md"]);
        expect(containsShellSubstitution("before !`unterminated")).toBe(false);
        expect(declarationName("nested\\fallback.md", ["command/"])).toBe("fallback");
        const obligation = {
            sourceReadObligationId: "obligation",
            sourceRootId: "root",
            sourceCapabilityFingerprint: DIGEST,
        };
        const left = {
            readEntryHandleId: "left",
            sourceReadObligationId: "obligation",
            sourceRootId: "root",
            relativePath: "a",
            entryKind: "file" as const,
        };
        const right = { ...left, readEntryHandleId: "right", relativePath: "b" };
        expect(ignoredDisposition(obligation, left, "not_selected")).toMatchObject({
            readEntryDispositionId: "disposition:left",
            disposition: "ignored",
            reasonCode: "not_selected",
        });
        expect(compareHandle(left, right)).toBeLessThan(0);
    });

    it("declares every AssetKind as a concrete reader or explicit unsupported disposition", () => {
        expect(Object.keys(OPENCODE_ASSET_READER_REGISTRY).sort()).toEqual([
            "Guidance",
            "Memory",
            "Rule",
            "Skill",
            "Subagent",
            "Workflow",
        ]);
        expect(OPENCODE_ASSET_READER_REGISTRY.Memory).toMatchObject({
            disposition: "unsupported",
            diagnosticCode: "opencode.memory_source_unsupported",
        });
        expect(OPENCODE_ASSET_READER_REGISTRY.Rule).toMatchObject({
            disposition: "unsupported",
            diagnosticCode: "opencode.rule_source_unsupported",
        });
        const unavailable = OPENCODE_ASSET_READER_REGISTRY.Memory;
        if (unavailable.disposition === "reader") throw new Error("Memory must remain explicitly unavailable");
        expect(OPENCODE_SOURCE_READ.diagnostics.readerUnavailable(configRoot(), unavailable)).toMatchObject({
            code: "opencode.memory_source_unsupported",
            causeKind: "unsupported",
        });
        expect(Object.values(OPENCODE_ASSET_READER_REGISTRY).filter((entry) => entry.disposition === "reader")).toHaveLength(4);
    });

    it("does not invent global Guidance in inactive declaration-only OpenCode config roots", async () => {
        const roots = [
            sourceRoot(
                "root-inactive-default-config",
                "/fixture/default-config",
                "config",
                "agent_runtime_private",
                "runtime_known_rule",
                "opencode_config_default",
            ),
            sourceRoot(
                "root-home-config",
                "/fixture/home/.opencode",
                "config",
                "agent_runtime_private",
                "runtime_known_rule",
                "opencode_home_config",
            ),
        ];
        for (const root of roots) {
            const capability = requiredCapability(
                (row) =>
                    row.assetKind === "Guidance" &&
                    row.entrySupportStatus === "supported" &&
                    row.rootRole === "config" &&
                    row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind,
            );
            const result = await opencodeProvider.read(
                rawReadInput(root, [capability], {
                    "AGENTS.md": "# Not loaded by this OpenCode root\n",
                }),
            );
            expect(result.candidates).toEqual([]);
            expect(result.sourceParseReports[0]).toMatchObject({
                status: "skipped_ignored_source",
                readEntryDispositions: expect.arrayContaining([
                    expect.objectContaining({
                        disposition: "ignored",
                        reasonCode: "outside_source_pattern",
                    }),
                ]),
            });
        }
    });

    it("reads Guidance from the active OPENCODE_CONFIG_DIR global root", async () => {
        const root = sourceRoot(
            "root-active-config-override",
            "/fixture/config-override",
            "config",
            "agent_runtime_private",
            "runtime_declared_path",
            "opencode_global_config:OPENCODE_CONFIG_DIR",
        );
        const capability = requiredCapability(
            (row) =>
                row.assetKind === "Guidance" &&
                row.entrySupportStatus === "supported" &&
                row.rootLocatorKind === "runtime_declared_path",
        );
        const result = await opencodeProvider.read(
            rawReadInput(root, [capability], { "AGENTS.md": "# Active override Guidance\n" }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                scope: "global",
                files: [expect.objectContaining({ text: "# Active override Guidance\n" })],
            }),
        ]);
    });

    it("preserves OpenCode Guidance fallback order and the independent Claude prompt gate", async () => {
        const all = await readProject(["Guidance"], {
            "AGENTS.md": "# Agents wins\n",
            "CLAUDE.md": "# Claude fallback\n",
            "CONTEXT.md": "# Deprecated fallback\n",
        });
        expect(all.candidates).toEqual([
            expect.objectContaining({
                displayName: "AGENTS.md",
                files: [expect.objectContaining({ text: "# Agents wins\n" })],
                nativeRepresentation: expect.objectContaining({
                    files: [expect.objectContaining({ relativePath: "AGENTS.md" })],
                }),
            }),
        ]);
        expect(all.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    disposition: "ignored",
                    reasonCode: "shadowed_guidance_source",
                }),
                expect.objectContaining({
                    disposition: "ignored",
                    reasonCode: "shadowed_guidance_source",
                }),
            ]),
        );

        const fallback = await readProject(["Guidance"], {
            "CLAUDE.md": "# Claude fallback\n",
            "CONTEXT.md": "# Deprecated fallback\n",
        });
        expect(fallback.candidates[0]).toMatchObject({ displayName: "CLAUDE.md" });

        const promptDisabled = sourceRoot(
            "root-project-no-claude-prompt",
            "/fixture/project",
            "project_actual",
            "project_root",
            "user_provided_path",
            "probe_project_root:project_config_on:external_skills_on:claude_prompt_off:claude_skills_on",
        );
        const guidance = projectCapabilities(["Guidance"])[0];
        if (guidance === undefined) throw new Error("missing Guidance capability");
        const disabled = await opencodeProvider.read(
            rawReadInput(promptDisabled, [guidance], {
                "CLAUDE.md": "# Must not load\n",
                "CONTEXT.md": "# Context fallback\n",
            }),
        );
        expect(disabled.candidates).toEqual([expect.objectContaining({ displayName: "CONTEXT.md" })]);
        expect(disabled.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({
                disposition: "ignored",
                reasonCode: "outside_source_pattern",
            }),
        );

        const globalClaudeRoot = sourceRoot(
            "root-global-claude-guidance",
            "/fixture/home/.claude",
            "config",
            "family_shared",
            "runtime_known_rule",
            "opencode_claude_compat_guidance",
        );
        const globalCapability = requiredCapability(
            (row) =>
                row.assetKind === "Guidance" &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "config" &&
                row.sourceDomain === "family_shared",
        );
        const global = await opencodeProvider.read(
            rawReadInput(globalClaudeRoot, [globalCapability], {
                "CLAUDE.md": "# Global Claude fallback\n",
            }),
        );
        expect(global.candidates).toEqual([expect.objectContaining({ displayName: "CLAUDE.md", scope: "global" })]);
    });

    it("honors an explicitly selected external scope without inferring that scope for probe roots", async () => {
        const root = externalRoot();
        const capability = externalCapability("Guidance");
        const global = await opencodeProvider.read(
            userSelectedReadInput(root, capability, "global", "", {
                "AGENTS.md": "# Global external\n",
            }),
        );
        expect(global.candidates[0]).toMatchObject({ scope: "global", projectRootPath: "" });

        const project = await opencodeProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/project", {
                "AGENTS.md": "# Project external\n",
            }),
        );
        expect(project.candidates[0]).toMatchObject({
            scope: "project",
            projectRootPath: "/fixture/project",
        });

        const inferred = await opencodeProvider.read(
            rawReadInput(root, [capability], { "AGENTS.md": "# must not infer scope\n" }),
        );
        expect(inferred.candidates).toEqual([]);
        expect(inferred.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode.source_scope_unresolved",
            }),
        );
    });

    it("uses the declared external layout for Workflow, Skill, and Subagent without scanning unrelated files", async () => {
        const root = externalRoot();
        const workflow = await opencodeProvider.read(
            userSelectedReadInput(root, externalCapability("Workflow"), "project", "/fixture/project", {
                "commands/team/review.md": fm("description: External command", "Review"),
                "unrelated.md": "not a command",
            }),
        );
        expect(workflow.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                displayName: "team/review",
                scope: "project",
            }),
        ]);

        const subagent = await opencodeProvider.read(
            userSelectedReadInput(root, externalCapability("Subagent"), "global", "", {
                "agents/reviewer.md": fm("description: External reviewer", "Review"),
            }),
        );
        expect(subagent.candidates).toEqual([
            expect.objectContaining({ kind: "Subagent", displayName: "reviewer", scope: "global" }),
        ]);

        const skill = await opencodeProvider.read(
            userSelectedReadInput(root, externalCapability("Skill"), "global", "", {
                "bundle/SKILL.md": fm("name: bundle\ndescription: Bundle", "Use it"),
                "bundle/resource.txt": "resource",
            }),
        );
        expect(skill.candidates).toEqual([
            expect.objectContaining({
                kind: "Skill",
                displayName: "bundle",
                files: expect.arrayContaining([expect.objectContaining({ logicalPath: "resource.txt" })]),
            }),
        ]);
    });

    it("reports unknown authority, report-only capability, roots without obligations, and failed resolution", async () => {
        const root = projectRoot();
        const guidance = projectCapabilities(["Guidance"])[0];
        if (guidance === undefined) throw new Error("missing Guidance capability");
        const input = rawReadInput(root, [guidance], {});
        input.sourceReadObligations.push({
            sourceReadObligationId: "unknown",
            sourceRootId: "missing-root",
            sourceCapabilityFingerprint: DIGEST,
        });
        input.readAccess = failingReadAccess();
        const result = await opencodeProvider.read(input);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode.read_authority_unknown",
            }),
        );
        expect(result.sourceParseReports[0]).toMatchObject({
            status: "empty",
            observedReadEntryIds: [],
        });

        const noObligation = await opencodeProvider.read(rawReadInput(root, [], {}));
        expect(noObligation.sourceParseReports).toEqual([
            expect.objectContaining({
                status: "deferred",
                diagnostics: [expect.objectContaining({ code: "opencode.root_without_obligation" })],
            }),
        ]);

        const fileRootInput = rawReadInput(root, [guidance], {});
        fileRootInput.readAccess = {
            ...fileRootInput.readAccess,
            async resolveRootEntry(obligationId, sourceRootId) {
                return succeeded("file-root", {
                    readEntryHandleId: "file-root-handle",
                    sourceReadObligationId: obligationId,
                    sourceRootId,
                    relativePath: "",
                    entryKind: "file" as const,
                });
            },
        };
        const fileRoot = await opencodeProvider.read(fileRootInput);
        expect(fileRoot.candidates).toEqual([]);
        expect(fileRoot.diagnostics).toContainEqual(expect.objectContaining({ code: "opencode.source_root_not_directory" }));
        expect(fileRoot.sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
            readEntryDispositions: [
                expect.objectContaining({
                    disposition: "ignored",
                    reasonCode: "source_root_not_directory",
                }),
            ],
        });
    });

    it("records directory and file read failures without inventing candidates", async () => {
        const root = projectRoot();
        const listFailure = readInput(root, ["Guidance"], { "AGENTS.md": "# Guidance" });
        listFailure.readAccess = {
            ...listFailure.readAccess,
            async listDirectory() {
                return failed("list-failed", "not_found");
            },
        };
        expect((await opencodeProvider.read(listFailure)).sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
        });

        const readFailure = readInput(root, ["Guidance"], { "AGENTS.md": "# Guidance" });
        readFailure.readAccess = {
            ...readFailure.readAccess,
            async readFile() {
                return failed("read-failed", "not_found");
            },
        };
        const result = await opencodeProvider.read(readFailure);
        expect(result.candidates).toEqual([]);
        expect(result.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "file_unreadable" }),
        );
    });

    it("does not fall through to lower-priority Guidance when the preferred file is unreadable", async () => {
        const input = readInput(projectRoot(), ["Guidance"], {
            "AGENTS.md": "# Preferred\n",
            "CLAUDE.md": "# Must not replace preferred\n",
        });
        let preferredHandleId: string | undefined;
        const listDirectory = input.readAccess.listDirectory.bind(input.readAccess);
        const readFile = input.readAccess.readFile.bind(input.readAccess);
        input.readAccess = {
            ...input.readAccess,
            async listDirectory(handleId) {
                const result = await listDirectory(handleId);
                if (result.state === "succeeded") {
                    preferredHandleId = result.value.children.find(
                        (child) => child.relativePath === "AGENTS.md",
                    )?.readEntryHandleId;
                }
                return result;
            },
            async readFile(handleId) {
                return handleId === preferredHandleId ? failed("preferred-read-failed", "not_found") : readFile(handleId);
            },
        };
        const result = await opencodeProvider.read(input);
        expect(preferredHandleId).toBeDefined();
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode.guidance_preferred_source_unreadable",
                path: "AGENTS.md",
            }),
        );
    });

    it("rejects empty/non-UTF8 Guidance without inventing command-style @ references", async () => {
        const rich = await readProject(["Guidance"], {
            "AGENTS.md": [
                "Read @docs/guide.md#part, @https://example.com/x and @~/.config/x.",
                "Ignore mail@example.com and @word but include @tab.md.",
                "```",
                "@hidden.md",
                "```",
            ].join("\n"),
            "ignored.md": "# ignored",
        });
        expect(rich.candidates).toHaveLength(1);
        expect(rich.candidates[0]?.files[0]?.references).toEqual([]);
        expect(rich.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({
                disposition: "ignored",
                reasonCode: "outside_source_pattern",
            }),
        );

        const empty = await readProject(["Guidance"], { "AGENTS.md": "  \n" });
        expect(empty.candidates).toEqual([]);
        expect(empty.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "empty_guidance" }),
        );

        const binary = await readProject(["Guidance"], {
            "AGENTS.md": new Uint8Array([0xff, 0xfe]),
        });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "opencode.declaration_not_utf8" }));
    });
});
