import { describe, expect, it } from "vitest";
import { codexProvider } from "../src/codex-provider";
import {
    configRoot,
    externalRoot,
    projectRoot,
    readWithFailure,
    readSubagent,
    subagentCapability,
    userSelectedReadInput,
} from "./codex-source-test-fixtures";

const VALID_AGENT = `name = "reviewer"
description = "Review a bounded change."
developer_instructions = "Inspect the requested files and report evidence."
model = "gpt-5.4"
model_reasoning_effort = "high"
nickname_candidates = ["review", "auditor"]
`;

describe("Codex Subagent source read", () => {
    it("imports a complete global custom-agent TOML with exact model and effort selectors", async () => {
        const result = await readSubagent(configRoot(), {
            "agents/reviewer.toml": VALID_AGENT,
            "agents/nested/ignored.toml": VALID_AGENT,
            "other.toml": VALID_AGENT,
        });
        expect(result.candidates).toHaveLength(1);
        const candidate = result.candidates[0];
        expect(candidate).toEqual(
            expect.objectContaining({
                kind: "Subagent",
                displayName: "reviewer",
                displayDescription: "Review a bounded change.",
                scope: "global",
                scopePath: "",
                status: "complete",
                assetCandidateStatus: "importable",
                nativeRepresentation: expect.objectContaining({
                    representationSource: "separate_files",
                    dialectId: "codex-subagent-toml-v2",
                    files: [expect.objectContaining({ relativePath: "agents/reviewer.toml" })],
                }),
                typeData: expect.objectContaining({
                    name: "reviewer",
                    directInvocation: { mode: "delegated_only" },
                    execution: expect.objectContaining({
                        model: {
                            mode: "selected",
                            dialectId: "codex-subagent-model-v1",
                            selector: "gpt-5.4",
                            relativeTier: -1,
                        },
                        effort: {
                            mode: "selected",
                            dialectId: "codex-subagent-reasoning-effort-v1",
                            selector: "high",
                            relativeTier: -1,
                        },
                    }),
                }),
            }),
        );
        expect(candidate?.files).toEqual([
            expect.objectContaining({
                logicalPath: "instructions.json",
                role: "entry",
                text: JSON.stringify({
                    schemaVersion: 1,
                    sections: [
                        {
                            title: "",
                            content: "Inspect the requested files and report evidence.",
                        },
                    ],
                }),
            }),
        ]);
        expect(candidate?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "codex.subagent_nicknames_native_only", severity: "warning" }),
        );
    });

    it("reads the exact project declaration directory and keeps an explicit selected root bounded", async () => {
        const project = await readSubagent(projectRoot(), {
            ".codex/agents/reviewer.toml": VALID_AGENT,
            ".codex/agents/nested/ignored.toml": VALID_AGENT,
            "agents/global.toml": VALID_AGENT,
        });
        expect(project.candidates).toEqual([
            expect.objectContaining({ kind: "Subagent", scope: "project", projectRootPath: "/fixture/project" }),
        ]);

        const root = externalRoot();
        const global = await codexProvider.read(
            userSelectedReadInput(root, subagentCapability(root), "global", "", {
                "agents/reviewer.toml": VALID_AGENT,
                ".codex/agents/project.toml": VALID_AGENT,
            }),
        );
        expect(global.candidates).toEqual([expect.objectContaining({ scope: "global", projectRootPath: "" })]);
    });

    it("rejects missing required fields, invalid TOML, and non-UTF-8 declarations", async () => {
        const fixtures = [
            `description = "missing name"\ndeveloper_instructions = "Body"\n`,
            `name = "reviewer"\ndeveloper_instructions = "Body"\n`,
            `name = "reviewer"\ndescription = "Description"\n`,
            `name = [\n`,
        ];
        for (const text of fixtures) {
            const result = await readSubagent(configRoot(), { "agents/reviewer.toml": text });
            expect(result.candidates, text).toEqual([]);
            expect(result.sourceParseReports[0]?.status, text).toBe("skipped_ignored_source");
        }
        const binary = await readSubagent(configRoot(), {
            "agents/reviewer.toml": new Uint8Array([0xff, 0xfe]),
        });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.subagent_source_not_utf8" }));

        const executableBit = await readSubagent(configRoot(), {
            "agents/reviewer.toml": { text: VALID_AGENT, executable: true },
        });
        expect(executableBit.candidates).toEqual([
            expect.objectContaining({
                status: "complete",
                files: [expect.objectContaining({ executable: false })],
                nativeRepresentation: expect.objectContaining({
                    files: [expect.objectContaining({ executable: true })],
                }),
            }),
        ]);
    });

    it("reports a matching custom-agent file that cannot be read", async () => {
        const root = configRoot();
        const result = await readWithFailure(
            root,
            subagentCapability(root),
            { "agents/reviewer.toml": VALID_AGENT },
            "agents/reviewer.toml",
        );
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.subagent_source_unreadable" }));
    });

    it("rejects executable authority and marks unowned behavior incomplete without silently mapping it", async () => {
        for (const field of [
            "hooks = {}",
            'mcp_servers.docs.command = "node"',
            'model_providers.remote.base_url = "https://x"',
        ]) {
            const result = await readSubagent(configRoot(), {
                "agents/reviewer.toml": `${VALID_AGENT}\n${field}\n`,
            });
            expect(result.candidates, field).toEqual([]);
            expect(result.diagnostics, field).toContainEqual(
                expect.objectContaining({ code: "codex.subagent_executable_source_rejected" }),
            );
        }

        for (const field of ['sandbox_mode = "workspace-write"', 'skills.config = [{ path = "../skill" }]']) {
            const result = await readSubagent(configRoot(), {
                "agents/reviewer.toml": `${VALID_AGENT}\n${field}\n`,
            });
            expect(result.candidates, field).toEqual([
                expect.objectContaining({
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: "codex.subagent_configuration_semantics_unsupported" }),
                    ]),
                }),
            ]);
        }
    });

    it("rejects invalid nickname and scalar field shapes rather than coercing TOML values", async () => {
        for (const nicknames of ['["review", 7]', "[]", '["same", "same"]', '["not/portable"]']) {
            const invalidNickname = await readSubagent(configRoot(), {
                "agents/reviewer.toml": VALID_AGENT.replace('["review", "auditor"]', nicknames),
            });
            expect(invalidNickname.candidates, nicknames).toEqual([
                expect.objectContaining({
                    status: "incomplete",
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: "codex.subagent_nickname_candidates_invalid" }),
                    ]),
                }),
            ]);
        }

        const invalidModel = await readSubagent(configRoot(), {
            "agents/reviewer.toml": VALID_AGENT.replace('model = "gpt-5.4"', "model = 7"),
        });
        expect(invalidModel.candidates).toEqual([
            expect.objectContaining({
                status: "incomplete",
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: "codex.subagent_field_invalid" })]),
            }),
        ]);
        expect(invalidModel.candidates[0]?.diagnostics).not.toContainEqual(
            expect.objectContaining({ code: "codex.subagent_required_field_missing" }),
        );
    });

    it("does not invent a nickname-count limit absent from the runtime schema", async () => {
        const nicknames = Array.from({ length: 65 }, (_, index) => `Agent ${index}`)
            .map((value) => `"${value}"`)
            .join(", ");
        const result = await readSubagent(configRoot(), {
            "agents/reviewer.toml": VALID_AGENT.replace('["review", "auditor"]', `[${nicknames}]`),
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                status: "complete",
                assetCandidateStatus: "importable",
                diagnostics: [expect.objectContaining({ code: "codex.subagent_nicknames_native_only" })],
            }),
        ]);
    });

    it("rejects duplicate agent identities within one source root instead of choosing a declaration", async () => {
        const result = await readSubagent(configRoot(), {
            "agents/first.toml": VALID_AGENT,
            "agents/second.toml": VALID_AGENT.replace("Review a bounded change.", "Review another bounded change."),
        });
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.filter((item) => item.code === "codex.subagent_name_duplicate")).toHaveLength(2);
        expect(result.sourceParseReports[0]).toMatchObject({ status: "skipped_ignored_source" });
    });
});
