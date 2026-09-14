import { describe, expect, it } from "vitest";
import type { AdapterExtractedAssetCandidate, NativeDialectValidationInputV1 } from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { validateZcodeNativeDialect } from "../src/zcode-source-read-native";
import { zcodeProvider } from "../src/zcode-provider";
import {
    commandRoot,
    configRoot,
    DIGEST,
    externalRoot,
    projectRoot,
    readWorkflow,
    userSelectedReadInput,
    workflowCapability,
} from "./zcode-source-test-fixtures";

const COMMAND = `---
description: Release the selected target.
allowed-tools: Read, Bash(git status)
argument-hint: <target>
model: glm-5
---

Release $1 after reviewing $ARGUMENTS.
`;

const SCRIPT = `export const meta = {
    name: "release-pipeline",
    description: "Run a bounded release pipeline.",
    phases: [{ title: "plan" }, { title: "publish", model: "glm-5" }],
};

await pipeline([agent("plan"), agent("publish")]);
`;

describe("ZCode Workflow source read", () => {
    it("reads nested global commands and script Workflows without executing JavaScript", async () => {
        const result = await readWorkflow(configRoot(), {
            "commands/release/deploy.md": COMMAND,
            "workflows/release.workflow.js": SCRIPT,
            "skills/not-a-command/SKILL.md": "ignored\n",
            "cli/sessions/private/workflows/instance.workflow.js": SCRIPT,
        });
        expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(["release:deploy", "release-pipeline"]);
        expect(result.candidates[0]).toEqual(
            expect.objectContaining({
                kind: "Workflow",
                status: "complete",
                assetCandidateStatus: "importable",
                scope: "global",
                files: [
                    expect.objectContaining({
                        logicalPath: "WORKFLOW.md",
                        text: "Release $1 after reviewing $ARGUMENTS.",
                    }),
                ],
                typeData: {
                    schemaVersion: 2,
                    name: "release:deploy",
                    description: "Release the selected target.",
                    implementation: {
                        kind: "instructions",
                        instructionDialectId: "zcode-command-markdown-v1",
                        execution: {
                            mode: "caller",
                            agent: { mode: "agent_runtime_default" },
                            model: {
                                mode: "selected",
                                dialectId: "zcode-model-selector-v1",
                                selector: "glm-5",
                                relativeTier: -1,
                            },
                            effort: { mode: "inherit" },
                            shell: { mode: "none" },
                        },
                        toolPolicy: {
                            preapproved: [
                                { dialectId: "zcode-command-tool-selector-v1", selector: "Read" },
                                { dialectId: "zcode-command-tool-selector-v1", selector: "Bash(git status)" },
                            ],
                            denied: [],
                            otherwise: "inherit_agent_runtime_policy",
                        },
                    },
                    invocation: {
                        commandNames: ["release:deploy"],
                        userInvocable: true,
                        agentInvocable: false,
                        argumentHint: "<target>",
                        argumentNames: ["1", "ARGUMENTS"],
                    },
                },
                nativeRepresentation: expect.objectContaining({ dialectId: "zcode-command-markdown-v1" }),
            }),
        );
        expect(result.candidates[1]).toEqual(
            expect.objectContaining({
                kind: "Workflow",
                status: "complete",
                files: [expect.objectContaining({ logicalPath: "workflow.js", mediaType: "text/javascript" })],
                typeData: expect.objectContaining({
                    name: "release-pipeline",
                    description: "Run a bounded release pipeline.",
                    implementation: {
                        kind: "executable",
                        executableDialectId: "zcode-script-workflow-javascript-v1",
                    },
                    invocation: expect.objectContaining({ userInvocable: true, agentInvocable: true }),
                }),
                nativeRepresentation: expect.objectContaining({ dialectId: "zcode-script-workflow-javascript-v1" }),
            }),
        );
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" })]),
        );
    });

    it("reads both project command roots plus project script Workflows", async () => {
        const result = await readWorkflow(projectRoot(), {
            ".zcode/commands/zcode.md": COMMAND,
            ".agents/commands/shared.md": COMMAND.replace("Release the selected target.", "Shared command."),
            ".zcode/workflows/project.workflow.js": SCRIPT.replace("release-pipeline", "project-pipeline"),
            ".zcode/agents/not-workflow.md": COMMAND,
        });
        expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(["shared", "zcode", "project-pipeline"]);
        expect(result.candidates.every((candidate) => candidate.scope === "project")).toBe(true);
        expect(result.candidates.every((candidate) => candidate.scopePath === "")).toBe(true);
    });

    it("projects minimal commands, fallback descriptions, and false optional flags", async () => {
        const result = await readWorkflow(commandRoot(), {
            "plain.md": "# Plain command\n\nRun $2.\n",
            "disabled.md": "---\ndisable-noninteractive: false\n---\nA visible command.\n",
            "bad name.md": "",
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayName: "bad name",
                displayDescription: "",
                status: "incomplete",
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({ code: "zcode.workflow_name_invalid" }),
                    expect.objectContaining({ code: "zcode.workflow_description_missing" }),
                ]),
            }),
            expect.objectContaining({ displayName: "disabled", displayDescription: "A visible command.", status: "complete" }),
            expect.objectContaining({
                displayName: "plain",
                displayDescription: "Plain command",
                typeData: expect.objectContaining({
                    invocation: expect.objectContaining({ argumentNames: ["2"] }),
                }),
            }),
        ]);
    });

    it("reads the family-shared command root but not script Workflow files", async () => {
        const result = await readWorkflow(commandRoot(), {
            "nested/shared.md": COMMAND,
            "ignored.workflow.js": SCRIPT,
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({ kind: "Workflow", displayName: "nested:shared", scope: "global" }),
        ]);
    });

    it("preserves invalid or unowned command semantics as incomplete instead of fake success", async () => {
        for (const [body, code] of [
            [COMMAND.replace("model: glm-5", "future-field: active"), "zcode.workflow_frontmatter_semantics_unsupported"],
            [COMMAND.replace("model: glm-5", "skills: release-helper"), "zcode.workflow_skill_binding_pending"],
            [COMMAND.replace("model: glm-5", "disable-noninteractive: true"), "zcode.workflow_interactive_only_unowned"],
            [COMMAND.replace("Release $1", "Run !`rm -rf never-executed` for $1"), "zcode.workflow_shell_expansion_unsupported"],
        ] as const) {
            const result = await readWorkflow(commandRoot(), { "unsafe.md": body });
            expect(result.candidates).toEqual([
                expect.objectContaining({
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    diagnostics: expect.arrayContaining([expect.objectContaining({ code, severity: "error" })]),
                }),
            ]);
        }
    });

    it("rejects binary commands and statically rejects dynamic or invalid script metadata", async () => {
        const binary = await readWorkflow(commandRoot(), { "binary.md": new Uint8Array([0xff, 0xfe]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.workflow_not_utf8" }));

        const scripts = [
            `export const meta = { name: (() => { throw new Error("must not execute") })(), description: "bad" };`,
            `export const meta = { name: "bad", description: "bad", phases: [{ title: "same" }, { title: "same" }] };`,
            `export const meta = { name: "bad", description: "bad", unknown: true };`,
            `console.log("before"); export const meta = { name: "bad", description: "bad" };`,
        ];
        for (const [index, script] of scripts.entries()) {
            const result = await readWorkflow(configRoot(), { [`workflows/bad-${index}.workflow.js`]: script });
            expect(result.candidates).toEqual([
                expect.objectContaining({
                    status: "incomplete",
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: "zcode.script_workflow_meta_invalid", severity: "error" }),
                    ]),
                }),
            ]);
        }
    });

    it("marks same-root normalized Workflow names as conflicts", async () => {
        const result = await readWorkflow(configRoot(), {
            "commands/Release.md": COMMAND,
            "commands/release.md": COMMAND,
        });
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(result.candidates[0]?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "zcode.workflow_duplicate_identity" }),
        );
    });

    it("honors user-selected Workflow scope without widening the root", async () => {
        const root = externalRoot();
        const capability = workflowCapability(root);
        const result = await zcodeProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/project", { "manual.md": COMMAND }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Workflow",
                scope: "project",
                scopePath: "",
                projectRootPath: "/fixture/project",
            }),
        ]);
    });

    it("revalidates Markdown and script native representations and rejects drift", async () => {
        const result = await readWorkflow(configRoot(), {
            "commands/release.md": COMMAND,
            "workflows/release.workflow.js": SCRIPT,
        });
        for (const candidate of result.candidates) {
            const input = nativeInput(candidate);
            expect(validateZcodeNativeDialect(input)).toBe(true);
            const contract = zcodeProvider.dialectContracts.native.find(
                (row) => row.definition.dialectId === candidate.nativeRepresentation.dialectId,
            );
            expect(contract?.validateSameContent(input)).toBe(true);

            const changed = structuredClone(input);
            changed.nativeFiles[0] = {
                relativePath: changed.nativeFiles[0]?.relativePath ?? "missing",
                bytes: Buffer.from("changed\n"),
            };
            expect(validateZcodeNativeDialect(changed)).toBe(false);

            const field =
                candidate.kind === "Workflow" && candidate.typeData.implementation.kind === "instructions"
                    ? "workflow_instruction"
                    : "workflow_executable";
            const portable = zcodeProvider.dialectContracts.portableEntries.find((row) => row.definition.field === field);
            if (portable === undefined) throw new Error(`missing ${field} contract`);
            const portableInput = {
                use: {
                    kind: "Workflow",
                    field,
                    dialectId:
                        candidate.kind === "Workflow" && candidate.typeData.implementation.kind === "instructions"
                            ? candidate.typeData.implementation.instructionDialectId
                            : candidate.kind === "Workflow"
                              ? candidate.typeData.implementation.executableDialectId
                              : "invalid",
                    logicalPath: candidate.files[0]?.logicalPath ?? "",
                },
                versionStatus: "complete",
                canonical: input.canonical,
                canonicalFiles: input.canonicalFiles,
            } as const;
            expect(portable.validateCanonicalEntry(portableInput as never)).toBe(true);
            expect(portable.validateCanonicalEntry({ ...portableInput, canonicalFiles: [] } as never)).toBe(false);
            expect(
                portable.validateCanonicalEntry({ ...portableInput, versionStatus: "incomplete", canonicalFiles: [] } as never),
            ).toBe(true);
            expect(
                portable.validateCanonicalEntry({
                    ...portableInput,
                    canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
                } as never),
            ).toBe(false);
        }

        for (const [root, files] of [
            [projectRoot(), { ".zcode/commands/release.md": COMMAND }],
            [projectRoot(), { ".agents/commands/release.md": COMMAND }],
            [projectRoot(), { ".zcode/workflows/release.workflow.js": SCRIPT }],
            [commandRoot(), { "release.md": COMMAND }],
            [commandRoot(), { "UPPER.MD": COMMAND }],
            [configRoot(), { "workflows/UPPER.WORKFLOW.JS": SCRIPT }],
        ] as const) {
            const layoutResult = await readWorkflow(root, files);
            const layoutCandidate = layoutResult.candidates[0];
            if (layoutCandidate === undefined) throw new Error("missing Workflow layout fixture");
            expect(validateZcodeNativeDialect(nativeInput(layoutCandidate))).toBe(true);
        }
        const external = externalRoot();
        const externalResult = await zcodeProvider.read(
            userSelectedReadInput(external, workflowCapability(external), "global", "", {
                "release.workflow.js": SCRIPT,
            }),
        );
        const externalCandidate = externalResult.candidates[0];
        if (externalCandidate === undefined) throw new Error("missing external Workflow fixture");
        expect(validateZcodeNativeDialect(nativeInput(externalCandidate))).toBe(true);

        const baselineCandidate = result.candidates[0];
        if (baselineCandidate === undefined) throw new Error("missing baseline Workflow fixture");
        const baseline = nativeInput(baselineCandidate);
        const wrongSchema = structuredClone(baseline);
        wrongSchema.representation.schemaVersion = 2 as never;
        expect(validateZcodeNativeDialect(wrongSchema)).toBe(false);
        const wrongKind = structuredClone(baseline);
        wrongKind.canonical = { kind: "Guidance", typeData: { schemaVersion: 1 } };
        expect(validateZcodeNativeDialect(wrongKind)).toBe(false);
        const emptyGraph = structuredClone(baseline);
        emptyGraph.representation.files = [];
        emptyGraph.nativeFiles = [];
        expect(validateZcodeNativeDialect(emptyGraph)).toBe(false);
        const escapingGraph = structuredClone(baseline);
        const escapingDescriptor = escapingGraph.representation.files[0];
        const escapingPayload = escapingGraph.nativeFiles[0];
        if (escapingDescriptor === undefined || escapingPayload === undefined) throw new Error("missing graph fixture");
        escapingDescriptor.relativePath = "../release.md";
        escapingPayload.relativePath = "../release.md";
        expect(validateZcodeNativeDialect(escapingGraph)).toBe(false);
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
