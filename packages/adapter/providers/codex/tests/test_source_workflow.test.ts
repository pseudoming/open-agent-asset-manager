import { describe, expect, it } from "vitest";
import { customPromptArguments } from "../src/codex-source-read-workflow";
import { configRoot, readWithFailure, readWorkflow, workflowCapability } from "./codex-source-test-fixtures";

describe("Codex deprecated Custom Prompt source read", () => {
    it("imports a top-level prompt with explicit invocation and exact placeholder order", async () => {
        const result = await readWorkflow(configRoot(), {
            "prompts/review.md": `---\ndescription: Review selected files\nargument-hint: FILE [FOCUS]\n---\nReview $FILE and $1. Keep $$HOME literal, then use $ARGUMENTS and $FILE.\n`,
            "prompts/nested/ignored.md": "Ignored\n",
            "commands/not-a-prompt.md": "Ignored\n",
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                displayName: "review",
                displayDescription: "Review selected files",
                scope: "global",
                scopePath: "",
                status: "complete",
                assetCandidateStatus: "importable",
                files: [expect.objectContaining({ logicalPath: "WORKFLOW.md" })],
                nativeRepresentation: expect.objectContaining({
                    representationSource: "separate_files",
                    dialectId: "codex-custom-prompt-markdown-v1",
                    files: [expect.objectContaining({ relativePath: "prompts/review.md" })],
                }),
                typeData: {
                    schemaVersion: 2,
                    name: "review",
                    description: "Review selected files",
                    implementation: {
                        kind: "instructions",
                        instructionDialectId: "codex-custom-prompt-markdown-v1",
                        execution: {
                            mode: "caller",
                            agent: { mode: "agent_runtime_default" },
                            model: { mode: "inherit" },
                            effort: { mode: "inherit" },
                            shell: { mode: "none" },
                        },
                        toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
                    },
                    invocation: {
                        commandNames: ["prompts:review"],
                        userInvocable: true,
                        agentInvocable: false,
                        argumentHint: "FILE [FOCUS]",
                        argumentNames: ["FILE", "1", "ARGUMENTS"],
                    },
                },
            }),
        ]);
    });

    it("accepts a prompt without frontmatter and keeps description and argument hint empty", async () => {
        const result = await readWorkflow(configRoot(), { "prompts/simple.md": "Do the bounded task.\n" });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayName: "simple",
                displayDescription: "",
                status: "complete",
                typeData: expect.objectContaining({
                    invocation: expect.objectContaining({ argumentHint: "", argumentNames: [] }),
                }),
                metadataSourceOrigins: [
                    expect.objectContaining({ metadataSubject: "display_name" }),
                    expect.objectContaining({ metadataSubject: "type_data" }),
                ],
            }),
        ]);
    });

    it("marks malformed, unknown, empty, or incorrectly typed prompt declarations incomplete", async () => {
        const fixtures = [
            "---\ndescription: missing close\nBody\n",
            "---\ndescription: Demo\nfuture: active\n---\nBody\n",
            "---\ndescription: 7\nargument-hint: false\n---\nBody\n",
            "---\ndescription: Empty\n---\n \n",
        ];
        for (const text of fixtures) {
            const result = await readWorkflow(configRoot(), { "prompts/demo.md": text });
            expect(result.candidates, text).toEqual([
                expect.objectContaining({ status: "incomplete", assetCandidateStatus: "incomplete" }),
            ]);
        }
    });

    it("rejects non-UTF-8 prompts while preserving an inert source execute bit only in native bytes", async () => {
        const binary = await readWorkflow(configRoot(), { "prompts/demo.md": new Uint8Array([0xff]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.workflow_source_not_utf8" }));

        const executableBit = await readWorkflow(configRoot(), {
            "prompts/demo.md": { text: "Body\n", executable: true },
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

        const missingName = await readWorkflow(configRoot(), { "prompts/.md": "Body\n" });
        expect(missingName.candidates).toEqual([]);
        expect(missingName.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.workflow_name_missing" }));
    });

    it("reports a matching Custom Prompt that cannot be read", async () => {
        const root = configRoot();
        const result = await readWithFailure(
            root,
            workflowCapability(root),
            { "prompts/review.md": "Review.\n" },
            "prompts/review.md",
        );
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.workflow_source_unreadable" }));
    });

    it("parses only documented positional, ARGUMENTS, and uppercase named placeholders", () => {
        expect(customPromptArguments("$1 $9 $0 $ARGUMENTS $FILE_NAME $File $lower $$ESCAPED $FILE_NAME")).toEqual([
            "1",
            "9",
            "ARGUMENTS",
            "FILE_NAME",
        ]);
    });
});
