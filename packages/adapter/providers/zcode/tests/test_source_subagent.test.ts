import { describe, expect, it } from "vitest";
import type { AdapterExtractedAssetCandidate, NativeDialectValidationInputV1 } from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { validateZcodeNativeDialect } from "../src/zcode-source-read-native";
import { zcodeProvider } from "../src/zcode-provider";
import {
    agentRoot,
    DIGEST,
    externalRoot,
    projectRoot,
    readSubagent,
    subagentCapability,
    userSelectedReadInput,
} from "./zcode-source-test-fixtures";

const SUBAGENT = `---
name: reviewer
description: Review changes conservatively.
color: blue
model: glm-5
tools: Read, Grep(pattern), Bash(git diff)
disallowedTools: Write, Edit
permissionMode: plan
maxTurns: 7
background: false
---

Review the requested changes and report evidence.
`;

describe("ZCode Subagent source read", () => {
    it("reads current global Subagent fields from the effective storage agent root", async () => {
        const result = await readSubagent(agentRoot(), {
            "reviewer.md": SUBAGENT,
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Subagent",
                displayName: "reviewer",
                displayDescription: "Review changes conservatively.",
                status: "complete",
                assetCandidateStatus: "importable",
                scope: "global",
                files: [expect.objectContaining({ logicalPath: "instructions.json", role: "entry" })],
                nativeRepresentation: expect.objectContaining({
                    dialectId: "zcode-subagent-markdown-v1",
                    files: [expect.objectContaining({ relativePath: "reviewer.md" })],
                }),
                typeData: {
                    schemaVersion: 2,
                    name: "reviewer",
                    description: "Review changes conservatively.",
                    promptContextPolicy: { mode: "agent_runtime_default" },
                    tools: {
                        availability: {
                            base: {
                                mode: "allowlist",
                                allowed: [
                                    {
                                        mode: "agent_runtime_tool",
                                        selector: { dialectId: "zcode-subagent-tool-name-v1", selector: "Read" },
                                    },
                                    {
                                        mode: "agent_runtime_tool",
                                        selector: { dialectId: "zcode-subagent-tool-name-v1", selector: "Grep" },
                                    },
                                    {
                                        mode: "agent_runtime_tool",
                                        selector: { dialectId: "zcode-subagent-tool-name-v1", selector: "Bash" },
                                    },
                                ],
                            },
                            unavailable: [
                                {
                                    mode: "agent_runtime_tool",
                                    selector: { dialectId: "zcode-subagent-tool-name-v1", selector: "Write" },
                                },
                                {
                                    mode: "agent_runtime_tool",
                                    selector: { dialectId: "zcode-subagent-tool-name-v1", selector: "Edit" },
                                },
                            ],
                        },
                        permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
                    },
                    dependencies: { preloadedSkillVersionIds: [] },
                    memory: { mode: "disabled" },
                    execution: {
                        permission: {
                            mode: "selected",
                            dialectId: "zcode-permission-mode-v1",
                            selector: "plan",
                            effect: "read_only",
                        },
                        workspaceIsolation: { mode: "agent_runtime_default" },
                        scheduling: { mode: "always_foreground" },
                        turnLimit: { mode: "bounded", dialectId: "zcode-max-turns-v1", limit: 7 },
                        model: {
                            mode: "selected",
                            dialectId: "zcode-model-selector-v1",
                            selector: "glm-5",
                            relativeTier: -1,
                        },
                        effort: { mode: "inherit" },
                        sampling: {
                            temperature: { mode: "agent_runtime_default" },
                            topP: { mode: "agent_runtime_default" },
                        },
                    },
                    directInvocation: { mode: "delegated_only" },
                    presentation: {
                        listing: "visible",
                        color: { mode: "selected", dialectId: "zcode-color-v1", selector: "blue" },
                    },
                },
            }),
        ]);
    });

    it("reads recursive project Markdown declarations from only .zcode/agents", async () => {
        const result = await readSubagent(projectRoot(), {
            ".zcode/agents/review/security.markdown": SUBAGENT.replace("name: reviewer", "name: security"),
            ".agents/agents/legacy.md": SUBAGENT.replace("name: reviewer", "name: legacy"),
            ".zcode/commands/not-agent.md": SUBAGENT,
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Subagent",
                displayName: "security",
                scope: "project",
                scopePath: "",
                typeData: expect.objectContaining({
                    execution: expect.objectContaining({ permission: { mode: "inherit" } }),
                }),
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({ code: "zcode.subagent_project_permission_ignored", severity: "warning" }),
                ]),
            }),
        ]);
    });

    it("inherits omitted policy and supports explicit background scheduling", async () => {
        const minimal = `---\nname: minimal\ndescription: Minimal agent.\n---\nDo the work.\n`;
        const result = await readSubagent(agentRoot(), {
            "minimal.md": minimal,
            "background.md": minimal.replace("name: minimal", "name: background").replace("---\nDo", "background: true\n---\nDo"),
            "empty-tools.md": minimal.replace("name: minimal", "name: empty-tools").replace("---\nDo", "tools: []\n---\nDo"),
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayName: "background",
                typeData: expect.objectContaining({
                    execution: expect.objectContaining({ scheduling: { mode: "always_background" } }),
                }),
            }),
            expect.objectContaining({
                displayName: "empty-tools",
                typeData: expect.objectContaining({
                    tools: expect.objectContaining({
                        availability: expect.objectContaining({ base: { mode: "inherit_available" } }),
                    }),
                }),
            }),
            expect.objectContaining({
                displayName: "minimal",
                typeData: expect.objectContaining({
                    tools: expect.objectContaining({
                        availability: expect.objectContaining({ base: { mode: "inherit_available" } }),
                    }),
                    execution: expect.objectContaining({
                        permission: { mode: "inherit" },
                        scheduling: { mode: "agent_runtime_default" },
                        model: { mode: "inherit" },
                    }),
                }),
            }),
        ]);
    });

    it("projects the current loose frontmatter and prompt normalization semantics", async () => {
        const result = await readSubagent(agentRoot(), {
            "normalized.md":
                "\ufeff---\n" +
                "name: normalized\n" +
                "description: Line\\nTwo\\tLiteral # runtime comment\n" +
                "tools: [Read, Bash(git diff, --stat)]\n" +
                "background: false\n" +
                "---\n\nPrompt with CRLF.\r\n\r\n",
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayDescription: "Line\nTwo\\tLiteral",
                typeData: expect.objectContaining({
                    description: "Line\nTwo\\tLiteral",
                    tools: expect.objectContaining({
                        availability: expect.objectContaining({
                            base: expect.objectContaining({
                                mode: "allowlist",
                                allowed: [
                                    expect.objectContaining({ selector: expect.objectContaining({ selector: "Read" }) }),
                                    expect.objectContaining({ selector: expect.objectContaining({ selector: "Bash" }) }),
                                ],
                            }),
                        }),
                    }),
                }),
                files: [
                    expect.objectContaining({
                        logicalPath: "instructions.json",
                        text: JSON.stringify({
                            schemaVersion: 1,
                            sections: [{ title: "", content: "Prompt with CRLF." }],
                        }),
                    }),
                ],
            }),
        ]);
    });

    it("rejects missing required fields, invalid UTF-8, hooks, and inline MCP authority", async () => {
        for (const source of [
            "No frontmatter\n",
            "---\nname: reviewer\ndescription: missing close\n",
            "---\ndescription: missing name\n---\nBody\n",
            "---\nname: reviewer\n---\nBody\n",
            "---\nname: reviewer\ndescription: empty\n---\n \n",
            SUBAGENT.replace("model: glm-5", "hooks: active"),
            SUBAGENT.replace("model: glm-5", "mcpServers: [private]"),
        ]) {
            const result = await readSubagent(agentRoot(), { "invalid.md": source });
            expect(result.candidates, source).toEqual([]);
            expect(result.sourceParseReports[0]?.status, source).toBe("skipped_ignored_source");
        }
        const binary = await readSubagent(agentRoot(), { "binary.md": new Uint8Array([0xff]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.subagent_not_utf8" }));
    });

    it("keeps unknown semantics and unbound Skill dependencies incomplete", async () => {
        for (const [source, code] of [
            [SUBAGENT.replace("model: glm-5", "future-field: active"), "zcode.subagent_frontmatter_semantics_unsupported"],
            [SUBAGENT.replace("model: glm-5", "skills: secure-review"), "zcode.subagent_skill_binding_pending"],
        ] as const) {
            const result = await readSubagent(agentRoot(), { "reviewer.md": source });
            expect(result.candidates).toEqual([
                expect.objectContaining({
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    diagnostics: expect.arrayContaining([expect.objectContaining({ code, severity: "error" })]),
                }),
            ]);
        }
    });

    it("mirrors ignored invalid runtime selectors without inventing authority", async () => {
        const result = await readSubagent(agentRoot(), {
            "reviewer.md": SUBAGENT.replace("color: blue", "color: ultraviolet")
                .replace("permissionMode: plan", "permissionMode: unknown")
                .replace("maxTurns: 7", "maxTurns: zero"),
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                status: "complete",
                typeData: expect.objectContaining({
                    execution: expect.objectContaining({
                        permission: { mode: "inherit" },
                        turnLimit: { mode: "agent_runtime_default" },
                    }),
                    presentation: expect.objectContaining({ color: { mode: "agent_runtime_default" } }),
                }),
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({ code: "zcode.subagent_color_ignored", severity: "warning" }),
                    expect.objectContaining({ code: "zcode.subagent_permission_ignored", severity: "warning" }),
                    expect.objectContaining({ code: "zcode.subagent_maxturns_invalid", severity: "warning" }),
                ]),
            }),
        ]);
    });

    it("marks duplicate Subagent names as conflicts", async () => {
        const result = await readSubagent(agentRoot(), {
            "one.md": SUBAGENT,
            "nested/two.md": SUBAGENT,
        });
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(result.candidates[0]?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "zcode.subagent_duplicate_identity" }),
        );
    });

    it("honors a user-selected Subagent scope", async () => {
        const root = externalRoot();
        const capability = subagentCapability(root);
        const result = await zcodeProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/project", { "reviewer.md": SUBAGENT }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({ kind: "Subagent", scope: "project", scopePath: "", projectRootPath: "/fixture/project" }),
        ]);
    });

    it("revalidates exact native Subagent bytes and rejects canonical or native drift", async () => {
        const result = await readSubagent(agentRoot(), { "reviewer.md": SUBAGENT });
        const candidate = result.candidates[0];
        if (candidate === undefined) throw new Error("missing Subagent fixture");
        const input = nativeInput(candidate);
        expect(validateZcodeNativeDialect(input)).toBe(true);
        const contract = zcodeProvider.dialectContracts.native.find(
            (row) => row.definition.dialectId === "zcode-subagent-markdown-v1",
        );
        expect(contract?.validateSameContent(input)).toBe(true);

        const changedNative = structuredClone(input);
        changedNative.nativeFiles[0] = { relativePath: "reviewer.md", bytes: Buffer.from("changed\n") };
        expect(validateZcodeNativeDialect(changedNative)).toBe(false);
        const changedCanonical = structuredClone(input);
        if (changedCanonical.canonical.kind === "Subagent") changedCanonical.canonical.typeData.description = "changed";
        expect(validateZcodeNativeDialect(changedCanonical)).toBe(false);

        for (const [root, files] of [[projectRoot(), { ".zcode/agents/reviewer.md": SUBAGENT }]] as const) {
            const layoutResult = await readSubagent(root, files);
            const layoutCandidate = layoutResult.candidates[0];
            if (layoutCandidate === undefined) throw new Error("missing Subagent layout fixture");
            expect(validateZcodeNativeDialect(nativeInput(layoutCandidate))).toBe(true);
        }
        const external = externalRoot();
        const externalResult = await zcodeProvider.read(
            userSelectedReadInput(external, subagentCapability(external), "global", "", { "reviewer.markdown": SUBAGENT }),
        );
        const externalCandidate = externalResult.candidates[0];
        if (externalCandidate === undefined) throw new Error("missing external Subagent fixture");
        expect(validateZcodeNativeDialect(nativeInput(externalCandidate))).toBe(true);
    });
});

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("fixture requires separate native files");
    }
    return {
        canonical: { kind: candidate.kind, typeData: candidate.typeData },
        canonicalFiles: candidate.files.map((file, index) => ({
            file: {
                fileId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                logicalPath: file.logicalPath,
                role: file.role,
                contentHash: DIGEST,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                byteSize: file.contentKind === "text" ? Buffer.byteLength(file.text) : file.bytes.byteLength,
                executable: file.executable,
                references: file.references ?? [],
            },
            ...(file.contentKind === "text"
                ? { contentKind: "text" as const, text: file.text }
                : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) }),
        })),
        representation: {
            schemaVersion: 1,
            dialectId: candidate.nativeRepresentation.dialectId,
            dialectContractFingerprint: DIGEST,
            canonicalContentFingerprint: DIGEST,
            files: candidate.nativeRepresentation.files.map((file) => ({
                relativePath: file.relativePath,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                contentHash: sha256SourceBytes(file.bytes),
                byteSize: file.bytes.byteLength,
                executable: file.executable,
            })),
            representationFingerprint: DIGEST,
        },
        nativeFiles: candidate.nativeRepresentation.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: new Uint8Array(file.bytes),
        })),
    };
}
