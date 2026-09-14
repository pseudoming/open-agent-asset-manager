import type { SourceRoot } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { claudecodeProvider } from "../src/claudecode-provider";
import { CLAUDECODE_SOURCE_READ } from "../src/claudecode-source-read";
import {
    DIGEST,
    failed,
    failingRootReadAccess,
    configRoot,
    memoryRoot,
    nonDirectoryRootReadAccess,
    projectCapabilities,
    projectRoot,
    rawReadInput,
    readInput,
    userSelectedReadInput,
} from "./claudecode-test-fixtures";

describe("Claude Code source-read authority boundaries", () => {
    it("supports a user-selected Memory root with explicit project scope", async () => {
        const root: SourceRoot = {
            sourceRootId: "external-memory",
            rootRole: "source",
            sourceDomain: "external_managed",
            path: "/fixture/external-memory",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "user_selected_root",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        };
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                row.assetKind === "Memory" &&
                row.rootLocatorKind === "user_provided_path" &&
                row.readPolicy === "user_selected_root_only",
        );
        if (capability === undefined) throw new Error("missing external Memory capability");
        const input = userSelectedReadInput(root, capability, "project", "/fixture/project", {
            "topic.md": `---\nname: Topic\ndescription: topic\ntype: reference\n---\nBody\n`,
        });
        const result = await claudecodeProvider.read(input);
        expect(result.candidates[0]).toMatchObject({
            scope: "project",
            projectRootPath: "/fixture/project",
        });
    });

    it("uses the user-selected scope for non-Memory config/project layouts", async () => {
        const root: SourceRoot = {
            sourceRootId: "external-guidance",
            rootRole: "source",
            sourceDomain: "external_managed",
            path: "/fixture/external-guidance",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "user_selected_root",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        };
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                row.assetKind === "Guidance" &&
                row.rootRole === "source" &&
                row.readPolicy === "user_selected_root_only",
        );
        if (capability === undefined) throw new Error("missing external Guidance capability");
        const global = await claudecodeProvider.read(
            userSelectedReadInput(root, capability, "global", "", {
                "CLAUDE.md": "# Global external\n",
            }),
        );
        expect(global.candidates[0]).toMatchObject({ scope: "global", projectRootPath: "" });

        const project = await claudecodeProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/project", {
                "CLAUDE.md": "# Project external\n",
            }),
        );
        expect(project.candidates[0]).toMatchObject({
            scope: "project",
            projectRootPath: "/fixture/project",
        });
    });

    it("rejects a project-keyed root that lacks an exact structured project association", async () => {
        const root = memoryRoot();
        const input = readInput(root, ["Memory"], { "topic.md": "topic" });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe roots");
        const agentRuntime = selector.observation.observedAgentRuntimes[0];
        if (agentRuntime === undefined) throw new Error("expected Claude Code agent runtime");
        agentRuntime.observedProjectIds = [];
        selector.observation.observedProjects = [];
        const result = await claudecodeProvider.read(input);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode.source_scope_unresolved",
            }),
        );
    });

    it("rejects an ambiguous project-keyed association instead of guessing one project path", async () => {
        const root = memoryRoot();
        const input = readInput(root, ["Memory"], { "topic.md": "topic" });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe roots");
        const secondProjectRoot: SourceRoot = {
            ...projectRoot(),
            sourceRootId: "root-project-second",
            path: "/fixture/project-second",
        };
        selector.observation.sourceRoots.push(secondProjectRoot);
        const agentRuntime = selector.observation.observedAgentRuntimes[0];
        if (agentRuntime === undefined) throw new Error("expected Claude Code agent runtime");
        agentRuntime.sourceRootIds.push(secondProjectRoot.sourceRootId);
        agentRuntime.observedProjectIds.push("claudecode-project-second");
        selector.observation.observedProjects.push({
            observedProjectId: "claudecode-project-second",
            runtimeProjectKey: "/fixture/project-second",
            displayName: "project-second",
            workspaces: [{ sourceRootId: secondProjectRoot.sourceRootId, role: "primary" }],
            evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
            diagnostics: [],
        });

        const result = await claudecodeProvider.read(input);

        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode.source_scope_unresolved",
            }),
        );
    });

    it("rejects unsupported probe-root ownership instead of guessing source scope", async () => {
        const root: SourceRoot = {
            ...projectRoot(),
            sourceRootId: "unknown-domain",
            rootRole: "source",
            sourceDomain: "external_managed",
        };
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.assetKind === "Guidance" &&
                row.rootLocatorKind === "user_provided_path" &&
                row.rootRole === "source" &&
                row.sourceDomain === "external_managed",
        );
        if (capability === undefined) throw new Error("missing external capability");
        const input = rawReadInput(root, [capability], { "CLAUDE.md": "# not selected\n" });
        const result = await claudecodeProvider.read(input);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode.source_scope_unresolved",
            }),
        );
    });

    it("reads one exact App project Guidance obligation through the shared physical source root", async () => {
        const root = projectRoot();
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_APP" &&
                row.assetKind === "Guidance" &&
                row.rootRole === "project_actual" &&
                row.entrySupportStatus === "supported" &&
                row.readPolicy === "auto_read",
        );
        if (capability === undefined) throw new Error("missing App project Guidance capability");
        const input = rawReadInput(root, [capability], { "CLAUDE.md": "# App project guidance\n" });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe-root selector");
        const runtime = selector.observation.observedAgentRuntimes[0];
        if (runtime === undefined) throw new Error("missing observed runtime fixture");
        runtime.agentRuntimeId = "CLAUDE_CODE_APP";

        const result = await claudecodeProvider.read(input);

        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                scope: "project",
                projectRootPath: root.path,
                files: [expect.objectContaining({ logicalPath: "GUIDANCE.md", text: "# App project guidance\n" })],
                nativeRepresentation: expect.objectContaining({ dialectId: "claudecode-guidance-markdown-v1" }),
            }),
        ]);
        expect(result.sourceParseReports).toEqual([expect.objectContaining({ status: "parsed", diagnostics: [] })]);
    });

    it("reads one exact App project Skill graph without borrowing the report-only global row", async () => {
        const root = projectRoot();
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_APP" &&
                row.assetKind === "Skill" &&
                row.rootRole === "project_actual" &&
                row.entrySupportStatus === "supported" &&
                row.readPolicy === "auto_read",
        );
        if (capability === undefined) throw new Error("missing App project Skill capability");
        const boundary = ".claude/skills/oaam-phase53-app-graph-skill";
        const input = rawReadInput(root, [capability], {
            [`${boundary}/SKILL.md`]: [
                "---",
                "name: oaam-phase53-app-graph-skill",
                "description: OAAM App Skill fixture",
                "disable-model-invocation: true",
                "---",
                "",
                "Use OAAM_APP_SKILL_GRAPH_LOADED_20260803_R1.",
                "",
            ].join("\n"),
            [`${boundary}/assets/marker.bin`]: Uint8Array.of(0, 255, 1),
            [`${boundary}/references/details.md`]: "# App Skill reference\n",
            [`${boundary}/scripts/marker.py`]: { text: "print('app-skill')\n", executable: true },
        });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe-root selector");
        const runtime = selector.observation.observedAgentRuntimes[0];
        if (runtime === undefined) throw new Error("missing observed runtime fixture");
        runtime.agentRuntimeId = "CLAUDE_CODE_APP";

        const result = await claudecodeProvider.read(input);

        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Skill",
                scope: "project",
                projectRootPath: root.path,
                status: "complete",
                files: expect.arrayContaining([
                    expect.objectContaining({ logicalPath: "SKILL.md", role: "entry" }),
                    expect.objectContaining({ logicalPath: "assets/marker.bin", contentKind: "binary" }),
                    expect.objectContaining({ logicalPath: "references/details.md", contentKind: "text" }),
                    expect.objectContaining({ logicalPath: "scripts/marker.py", executable: true }),
                ]),
                nativeRepresentation: expect.objectContaining({
                    dialectId: "claudecode-skill-directory-v1",
                    files: expect.arrayContaining([
                        expect.objectContaining({ relativePath: `${boundary}/SKILL.md` }),
                        expect.objectContaining({ relativePath: `${boundary}/scripts/marker.py`, executable: true }),
                    ]),
                }),
            }),
        ]);
        expect(result.sourceParseReports).toEqual([expect.objectContaining({ status: "parsed", diagnostics: [] })]);
    });

    it("reads only the selected App project Rule, Workflow variants, and Subagent obligations", async () => {
        const root = projectRoot();
        const capabilities = (["Rule", "Workflow", "Subagent"] as const).map((assetKind) => {
            const capability = claudecodeProvider.assetSourceCapabilities.find(
                (row) =>
                    row.agentRuntimeId === "CLAUDE_CODE_APP" &&
                    row.assetKind === assetKind &&
                    row.rootRole === "project_actual" &&
                    row.entrySupportStatus === "supported" &&
                    row.readPolicy === "auto_read",
            );
            if (capability === undefined) throw new Error(`missing App project ${assetKind} capability`);
            return capability;
        });
        const input = rawReadInput(root, capabilities, {
            ".claude/rules/oaam-app-rule.md": "---\nname: OAAM App Rule\n---\nOAAM_APP_RULE_SOURCE_R1\n",
            ".claude/commands/oaam-app-command.md":
                "---\nname: oaam-app-command\ndescription: App command\n---\nOAAM_APP_COMMAND_SOURCE_R1\n",
            ".claude/workflows/oaam-app-js/index.js": {
                text: 'export const meta = { name: "oaam-app-js", description: "App JS workflow" };\n',
                executable: true,
            },
            ".claude/workflows/oaam-app-js/resources/marker.bin": Uint8Array.of(0, 255, 44),
            ".claude/agents/oaam-app-agent.md": [
                "---",
                "name: oaam-app-agent",
                "description: App project agent",
                "initialPrompt: OAAM_APP_AGENT_INITIAL_R1",
                "---",
                "OAAM_APP_AGENT_BODY_R1",
                "",
            ].join("\n"),
        });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe-root selector");
        const runtime = selector.observation.observedAgentRuntimes[0];
        if (runtime === undefined) throw new Error("missing observed runtime fixture");
        runtime.agentRuntimeId = "CLAUDE_CODE_APP";

        const result = await claudecodeProvider.read(input);

        expect(result.candidates.map((candidate) => [candidate.kind, candidate.nativeRepresentation?.dialectId])).toEqual([
            ["Rule", "claudecode-rule-markdown-v1"],
            ["Subagent", "claudecode-subagent-markdown-v1"],
            ["Workflow", "claudecode-command-markdown-v1"],
            ["Workflow", "claudecode-js-workflow-v1"],
        ]);
        expect(
            result.candidates.find((candidate) => candidate.displayName === "oaam-app-js")?.nativeRepresentation?.files,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ relativePath: ".claude/workflows/oaam-app-js/index.js", executable: true }),
                expect.objectContaining({ relativePath: ".claude/workflows/oaam-app-js/resources/marker.bin" }),
            ]),
        );
        expect(result.sourceParseReports).toHaveLength(1);
        expect(result.sourceParseReports.every((report) => report.status === "parsed" && report.diagnostics.length === 0)).toBe(
            true,
        );
    });

    it("reads the exact App project Memory Catalog and topic from its selected project-keyed root", async () => {
        const root = memoryRoot();
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_APP" &&
                row.assetKind === "Memory" &&
                row.rootLocatorKind === "runtime_known_rule" &&
                row.rootRole === "source" &&
                row.sourceDomain === "project_keyed" &&
                row.entrySupportStatus === "supported" &&
                row.readPolicy === "auto_read",
        );
        if (capability === undefined) throw new Error("missing App project Memory capability");
        const input = rawReadInput(root, [capability], {
            "MEMORY.md": "# App Memory\n\n- [OAAM App topic](topics/app.md) — exact App topic\n",
            "topics/app.md": [
                "---",
                "name: OAAM App topic",
                "description: Exact App Memory topic",
                "type: project",
                "---",
                "OAAM_APP_MEMORY_SOURCE_R1",
                "",
            ].join("\n"),
        });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe-root selector");
        const runtime = selector.observation.observedAgentRuntimes[0];
        if (runtime === undefined) throw new Error("missing observed runtime fixture");
        runtime.agentRuntimeId = "CLAUDE_CODE_APP";
        const project = projectRoot();
        selector.observation.sourceRoots.push(project);
        runtime.sourceRootIds.push(project.sourceRootId);
        runtime.observedProjectIds.push("claudecode-app-project");
        selector.observation.observedProjects.push({
            observedProjectId: "claudecode-app-project",
            runtimeProjectKey: project.path,
            displayName: "project",
            workspaces: [{ sourceRootId: project.sourceRootId, role: "primary" }],
            evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
            diagnostics: [],
        });

        const result = await claudecodeProvider.read(input);

        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Memory",
                scope: "project",
                status: "complete",
                typeData: expect.objectContaining({ entityRole: "catalog" }),
                memoryCatalogMemberBindingInputs: [
                    { rawTarget: "topics/app.md", routingTitle: "OAAM App topic", routingHint: "exact App topic" },
                ],
            }),
            expect.objectContaining({
                kind: "Memory",
                scope: "project",
                status: "complete",
                typeData: expect.objectContaining({ entityRole: "unit" }),
                nativeRepresentation: expect.objectContaining({
                    dialectId: "claudecode-memory-topic-v1",
                    files: [expect.objectContaining({ relativePath: "topics/app.md" })],
                }),
            }),
        ]);
        expect(result.sourceParseReports).toEqual([expect.objectContaining({ status: "parsed", diagnostics: [] })]);
    });

    it("reads all five App declaration kinds through one selected shared configuration root", async () => {
        const root = configRoot();
        const capabilities = (["Guidance", "Rule", "Workflow", "Skill", "Subagent"] as const).map((assetKind) => {
            const capability = claudecodeProvider.assetSourceCapabilities.find(
                (row) =>
                    row.agentRuntimeId === "CLAUDE_CODE_APP" &&
                    row.assetKind === assetKind &&
                    row.rootLocatorKind === "runtime_known_rule" &&
                    row.rootRole === "config" &&
                    row.sourceDomain === "agent_runtime_private" &&
                    row.entrySupportStatus === "supported" &&
                    row.readPolicy === "auto_read",
            );
            if (capability === undefined) throw new Error(`missing App configuration ${assetKind} capability`);
            return capability;
        });
        const input = rawReadInput(root, capabilities, {
            "CLAUDE.md": "# OAAM_APP_GLOBAL_GUIDANCE_SOURCE_R1\n",
            "rules/private.md": "---\nname: App private rule\n---\nOAAM_APP_GLOBAL_RULE_SOURCE_R1\n",
            "commands/private.md": [
                "---",
                "name: app-global-command",
                "description: App global command",
                "---",
                "OAAM_APP_GLOBAL_COMMAND_SOURCE_R1",
                "",
            ].join("\n"),
            "workflows/app-global-js/index.js": {
                text: 'export const meta = { name: "app-global-js", description: "App global JS workflow" };\n',
                executable: true,
            },
            "workflows/app-global-js/resources/marker.bin": Uint8Array.of(0, 255, 47),
            "skills/app-global-skill/SKILL.md": [
                "---",
                "name: app-global-skill",
                "description: App global Skill",
                "---",
                "OAAM_APP_GLOBAL_SKILL_SOURCE_R1",
                "",
            ].join("\n"),
            "skills/app-global-skill/references/details.md": "# OAAM App global Skill reference\n",
            "agents/app-global-agent.md": [
                "---",
                "name: app-global-agent",
                "description: App global Subagent",
                "initialPrompt: OAAM_APP_GLOBAL_AGENT_INITIAL_R1",
                "---",
                "OAAM_APP_GLOBAL_AGENT_BODY_R1",
                "",
            ].join("\n"),
        });
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("expected probe-root selector");
        const runtime = selector.observation.observedAgentRuntimes[0];
        if (runtime === undefined) throw new Error("missing observed runtime fixture");
        runtime.agentRuntimeId = "CLAUDE_CODE_APP";

        const result = await claudecodeProvider.read(input);

        expect(result.candidates.map((candidate) => [candidate.kind, candidate.nativeRepresentation?.dialectId])).toEqual([
            ["Guidance", "claudecode-guidance-markdown-v1"],
            ["Rule", "claudecode-rule-markdown-v1"],
            ["Skill", "claudecode-skill-directory-v1"],
            ["Subagent", "claudecode-subagent-markdown-v1"],
            ["Workflow", "claudecode-command-markdown-v1"],
            ["Workflow", "claudecode-js-workflow-v1"],
        ]);
        expect(result.candidates.every((candidate) => candidate.scope === "global" && candidate.projectRootPath === "")).toBe(
            true,
        );
        expect(result.candidates.find((candidate) => candidate.kind === "Rule")).toMatchObject({
            files: [expect.objectContaining({ logicalPath: "RULE.md", text: "OAAM_APP_GLOBAL_RULE_SOURCE_R1\n" })],
            nativeRepresentation: expect.objectContaining({
                files: [expect.objectContaining({ relativePath: "rules/private.md" })],
            }),
        });
        expect(result.candidates.find((candidate) => candidate.kind === "Skill")).toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({ logicalPath: "SKILL.md" }),
                expect.objectContaining({ logicalPath: "references/details.md" }),
            ]),
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "app-global-js")).toMatchObject({
            nativeRepresentation: expect.objectContaining({
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: "workflows/app-global-js/index.js", executable: true }),
                    expect.objectContaining({ relativePath: "workflows/app-global-js/resources/marker.bin" }),
                ]),
            }),
        });
        expect(result.sourceParseReports).toEqual([expect.objectContaining({ status: "parsed", diagnostics: [] })]);
    });

    it("reports unknown obligations and failed root resolution without inventing candidates", async () => {
        const root = projectRoot();
        const capability = projectCapabilities(["Guidance"])[0];
        if (capability === undefined) throw new Error("missing fixture capability");
        const input = readInput(root, ["Guidance"], {});
        input.sourceReadObligations.push({
            sourceReadObligationId: "unknown",
            sourceRootId: "missing-root",
            sourceCapabilityFingerprint: DIGEST,
        });
        input.readAccess = failingRootReadAccess();
        const result = await claudecodeProvider.read(input);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode.read_authority_unknown",
            }),
        );
        expect(result.sourceParseReports[0]).toMatchObject({
            status: "empty",
            observedReadEntryIds: [],
        });
    });

    it("reports roots with no obligations and non-directory/unreadable handles truthfully", async () => {
        const root = projectRoot();
        const noObligation = rawReadInput(root, [], {});
        const noObligationResult = await claudecodeProvider.read(noObligation);
        expect(noObligationResult.sourceParseReports).toEqual([
            expect.objectContaining({
                status: "deferred",
                diagnostics: [expect.objectContaining({ code: "claudecode.root_without_obligation" })],
            }),
        ]);

        const nonDirectory = readInput(root, ["Guidance"], {});
        nonDirectory.readAccess = nonDirectoryRootReadAccess(root);
        const nonDirectoryResult = await claudecodeProvider.read(nonDirectory);
        expect(nonDirectoryResult.sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
            diagnostics: [expect.objectContaining({ code: "claudecode.source_root_not_directory" })],
        });

        const listFailure = readInput(root, ["Guidance"], { "CLAUDE.md": "# Guidance" });
        const listBase = listFailure.readAccess;
        listFailure.readAccess = {
            ...listBase,
            async listDirectory() {
                return failed("list-failed", "not_found");
            },
        };
        expect((await claudecodeProvider.read(listFailure)).sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
        });

        const readFailure = readInput(root, ["Guidance"], { "CLAUDE.md": "# Guidance" });
        const readBase = readFailure.readAccess;
        readFailure.readAccess = {
            ...readBase,
            async readFile() {
                return failed("read-failed", "not_found");
            },
        };
        const readFailureResult = await claudecodeProvider.read(readFailure);
        expect(readFailureResult.candidates).toEqual([]);
        expect(readFailureResult.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "file_unreadable" }),
        );
    });

    it("keeps non-callable and unavailable reader diagnostics specific to the selected root", () => {
        const root = projectRoot();
        expect(CLAUDECODE_SOURCE_READ.diagnostics.capabilityNotCallable(root)).toMatchObject({
            code: "claudecode.source_capability_not_callable",
            causeKind: "unsupported",
            path: root.path,
        });
        expect(
            CLAUDECODE_SOURCE_READ.diagnostics.readerUnavailable(root, {
                readerKind: "report_only",
                diagnosticCode: "claudecode.fixture_reader_unavailable",
                message: "fixture reader is unavailable",
            }),
        ).toMatchObject({
            code: "claudecode.fixture_reader_unavailable",
            causeKind: "unsupported",
            path: root.path,
        });
    });
});
