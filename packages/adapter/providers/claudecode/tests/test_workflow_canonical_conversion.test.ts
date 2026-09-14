import { describe, expect, it } from "vitest";
import type {
    CanonicalMaterializationAssessmentInput,
    CanonicalNativePreservationSeed,
    NativeProjectExactGraphCanonicalMaterializationInput,
    WorkflowTypeDataV2,
} from "@oaam/core/adapter-spi";
import { CLAUDECODE_NATIVE_DIALECTS } from "../src/claudecode-source-read-model";
import { createClaudeWorkflowCanonicalMaterializer } from "../src/claudecode-target-workflow-canonical";
import { parseChangedClaudeCodeNativeDocument } from "../src/claudecode-target-global-native-document";

const ref = { assetId: "11111111-1111-4111-8111-111111111111", versionId: "22222222-2222-4222-8222-222222222222" };
const hash = ("sha256:" + "1".repeat(64)) as `sha256:${string}`;
const body = "Review the changes.\n\n```bash\nBASE_BRANCH=${BASE_BRANCH:-main}\nprintf '%s\\n' \"$BASE_BRANCH\"\n```\n";
const nativeDialectId = CLAUDECODE_NATIVE_DIALECTS.commandWorkflow;
function data(): WorkflowTypeDataV2 {
    return {
        schemaVersion: 2,
        name: "git-review",
        description: "Review Git changes.",
        invocation: {
            userInvocable: true,
            agentInvocable: true,
            commandNames: ["git-review"],
            argumentNames: [],
            argumentHint: "[scope]",
        },
        implementation: {
            kind: "instructions",
            instructionDialectId: "antigravity-workflow-markdown-v1",
            execution: {
                mode: "caller",
                agent: { mode: "agent_runtime_default" },
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
                shell: { mode: "none" },
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
        },
    };
}
function assessment(typeData = data(), text = body): CanonicalMaterializationAssessmentInput {
    return {
        canonical: { kind: "Workflow", typeData },
        canonicalEntry: { contentKind: "text", text },
        targetVersion: ref,
        targetScope: "project",
        nativeDialectId,
    };
}
function source(text = body, extra = ""): CanonicalNativePreservationSeed {
    const nativeText = "---\nname: git-review\ndescription: Review Git changes.\n" + extra + "---\n" + text;
    const file = {
        relativePath: ".agents/workflows/git-review.md",
        contentKind: "text" as const,
        mediaType: "text/markdown",
        executable: false,
        contentHash: hash,
        byteSize: Buffer.byteLength(nativeText),
        text: nativeText,
    };
    const { text: _text, ...descriptor } = file;
    return {
        representation: {
            schemaVersion: 1,
            dialectId: "antigravity-workflow-markdown-v1",
            dialectContractFingerprint: hash,
            canonicalContentFingerprint: hash,
            representationFingerprint: hash,
            files: [descriptor],
        },
        files: [file],
    };
}

describe("Claude reviewed instruction Workflow conversion", () => {
    it.each([
        "project",
        "global",
    ] as const)("preserves both invocation controls, the hint and ordinary Shell text for %s", (scope) => {
        const materializer = createClaudeWorkflowCanonicalMaterializer(scope);
        for (const userInvocable of [false, true])
            for (const agentInvocable of [false, true]) {
                const typeData = data();
                typeData.invocation.userInvocable = userInvocable;
                typeData.invocation.agentInvocable = agentInvocable;
                const input = { ...assessment(typeData), targetScope: scope, nativePreservationSeed: source() };
                expect(materializer.assessLoss!(input)).toEqual([]);
                const request: NativeProjectExactGraphCanonicalMaterializationInput = {
                    assetKind: "Workflow",
                    targetCanonical: { kind: "Workflow", typeData },
                    targetScope: scope,
                    targetVersion: ref,
                    nativeDialectId,
                    nativePreservationSeed: input.nativePreservationSeed,
                    restorationInputs: [],
                    targetFiles: [
                        {
                            file: {
                                fileId: "entry",
                                logicalPath: "WORKFLOW.md",
                                role: "entry",
                                contentKind: "text",
                                mediaType: "text/markdown",
                                executable: false,
                                byteSize: Buffer.byteLength(body),
                                contentHash: hash,
                            },
                            contentKind: "text",
                            text: body,
                        },
                    ],
                };
                const result = materializer.materialize(request);
                expect(result?.nativeFiles).toHaveLength(1);
                const file = result!.nativeFiles[0]!;
                if (file.contentKind !== "text") throw new Error("Text command missing");
                expect(file.relativePath).toBe((scope === "project" ? ".claude/" : "") + "commands/git-review.md");
                expect(file.text).toContain("user-invocable: " + userInvocable);
                expect(file.text).toContain("disable-model-invocation: " + !agentInvocable);
                expect(file.text).toContain('argument-hint: "[scope]"');
                expect(file.text.endsWith(body)).toBe(true);
                const validation = {
                    ...input,
                    nativeEntry: { relativePath: file.relativePath, content: { contentKind: "text" as const, text: file.text } },
                };
                expect(materializer.validateEntry(validation)).toBe(true);
                expect(
                    materializer.validateEntry({
                        ...validation,
                        nativeEntry: {
                            ...validation.nativeEntry,
                            content: {
                                contentKind: "text",
                                text: file.text.replace("user-invocable: " + userInvocable, "user-invocable: " + !userInvocable),
                            },
                        },
                    }),
                ).toBe(false);
                expect(
                    materializer.validateEntry({
                        ...validation,
                        nativeEntry: { ...validation.nativeEntry, relativePath: "commands/other.md" },
                    }),
                ).toBe(false);
            }
    });
    it.each([
        "Use $ARGUMENTS",
        "Use $1",
        "Use ${CLAUDE_SKILL_DIR}",
        "Execute !`echo unexpected`",
        "```!\necho unexpected\n```",
    ])("blocks foreign text that would acquire Claude substitution or execution: %s", (text) => {
        expect(createClaudeWorkflowCanonicalMaterializer("project").assessLoss!(assessment(data(), text))).toBeNull();
    });
    it("blocks private source fields, changed source bodies and unknown preservation dialects", () => {
        const materializer = createClaudeWorkflowCanonicalMaterializer("project");
        for (const seed of [
            source(body, "execution-mode: isolated\n"),
            source("Different body"),
            { ...source(), representation: { ...source().representation, dialectId: "unknown-workflow-v1" } },
            { ...source(), files: [] },
        ]) {
            expect(materializer.assessLoss!({ ...assessment(), nativePreservationSeed: seed })).toBeNull();
        }
    });
    const blocked: [string, (value: WorkflowTypeDataV2) => void][] = [
        [
            "different command identity",
            (value) => {
                value.invocation.commandNames = ["other"];
            },
        ],
        [
            "argument substitution",
            (value) => {
                value.invocation.argumentNames = ["branch"];
            },
        ],
        [
            "unsafe path",
            (value) => {
                value.name = "../outside";
                value.invocation.commandNames = [value.name];
            },
        ],
        [
            "unknown instruction dialect",
            (value) => {
                if (value.implementation.kind === "instructions")
                    value.implementation.instructionDialectId = "unknown-workflow-v1";
            },
        ],
        [
            "tool preapproval",
            (value) => {
                if (value.implementation.kind === "instructions")
                    value.implementation.toolPolicy.preapproved = [
                        { dialectId: "claudecode-tool-selector-v1", selector: "Bash" },
                    ];
            },
        ],
        [
            "isolated execution",
            (value) => {
                if (value.implementation.kind === "instructions") value.implementation.execution.mode = "isolated";
            },
        ],
    ];
    it.each(blocked)("blocks %s without silently losing behavior", (_name, mutate) => {
        const value = data();
        mutate(value);
        expect(createClaudeWorkflowCanonicalMaterializer("project").assessLoss!(assessment(value))).toBeNull();
    });
    it.each([
        "project",
        "global",
    ] as const)("retains the existing nested native command body reverse boundary for %s", (scope) => {
        const text = "---\nname: nested-review\ndescription: Native command.\n---\nReview $ARGUMENTS.\n";
        const relativePath = ((scope === "project" ? ".claude/" : "") +
            "commands/nested/nested-review.md") as "commands/nested/nested-review.md";
        const input = {
            assetKind: "Workflow" as const,
            nativeDialectId,
            relativePath,
            appliedContent: { contentKind: "text" as const, text },
            currentContent: { contentKind: "text" as const, text: text + "Check one more item.\n" },
        };
        expect(parseChangedClaudeCodeNativeDocument(input, { assetKind: "Workflow", nativeDialectId }, scope)).toEqual({
            canonicalContent: { contentKind: "text", text: "Review $ARGUMENTS.\nCheck one more item.\n" },
        });
        expect(
            parseChangedClaudeCodeNativeDocument(
                {
                    ...input,
                    currentContent: {
                        contentKind: "text",
                        text: text.replace("Native command.", "Changed invocation description."),
                    },
                },
                { assetKind: "Workflow", nativeDialectId },
                scope,
            ),
        ).toBeNull();
    });
});
