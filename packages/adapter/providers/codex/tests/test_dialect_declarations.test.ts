import { describe, expect, it } from "vitest";
import type {
    AdapterExtractedAssetCandidate,
    NativeDialectValidationInputV1,
    PortableEntryDialectValidationInputV1,
    UuidV4,
} from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { codexProvider } from "../src/codex-provider";
import { validateCodexNativeDialect } from "../src/codex-source-read-native";
import { configRoot, DIGEST, readSubagent, readWorkflow } from "./codex-source-test-fixtures";

const AGENT = `name = "reviewer"
description = "Review files."
developer_instructions = "Review the selected files."
model = "gpt-5.4"
model_reasoning_effort = "high"
`;

describe("Codex Subagent and Workflow dialect contracts", () => {
    it("re-parses exact custom-agent TOML and rejects changed native or canonical semantics", async () => {
        const result = await readSubagent(configRoot(), { "agents/reviewer.toml": AGENT });
        const candidate = requiredCandidate(result.candidates, "Subagent");
        const input = nativeInput(candidate);
        expect(validateCodexNativeDialect(input)).toBe(true);
        expect(nativeContract("codex-subagent-toml-v2").validateSameContent(input)).toBe(true);

        const legacy = structuredClone(input);
        legacy.representation.dialectId = "codex-subagent-toml-v1";
        const legacyEntry = legacy.canonicalFiles[0];
        if (legacyEntry?.contentKind !== "text") throw new Error("missing legacy Subagent entry fixture");
        legacyEntry.text = legacyEntry.text.replace('"title":""', '"title":"Developer instructions"');
        expect(validateCodexNativeDialect(legacy)).toBe(true);
        expect(nativeContract("codex-subagent-toml-v1").validateSameContent(legacy)).toBe(true);

        const legacyDialectWithCurrentCanonical = structuredClone(input);
        legacyDialectWithCurrentCanonical.representation.dialectId = "codex-subagent-toml-v1";
        expect(validateCodexNativeDialect(legacyDialectWithCurrentCanonical)).toBe(false);

        const currentDialectWithLegacyCanonical = structuredClone(legacy);
        currentDialectWithLegacyCanonical.representation.dialectId = "codex-subagent-toml-v2";
        expect(validateCodexNativeDialect(currentDialectWithLegacyCanonical)).toBe(false);

        const changedNative = structuredClone(input);
        changedNative.nativeFiles[0] = {
            relativePath: "agents/reviewer.toml",
            bytes: Buffer.from(AGENT.replace('model = "gpt-5.4"', 'model = "gpt-5.5"')),
        };
        expect(validateCodexNativeDialect(changedNative)).toBe(false);

        const changedCanonical = structuredClone(input);
        if (changedCanonical.canonical.kind !== "Subagent") throw new Error("missing Subagent canonical fixture");
        changedCanonical.canonical.typeData.execution.model = { mode: "inherit" };
        expect(validateCodexNativeDialect(changedCanonical)).toBe(false);
    });

    it("re-parses exact custom-prompt Markdown and validates only the CLI Workflow entry dialect", async () => {
        const result = await readWorkflow(configRoot(), {
            "prompts/review.md": "---\ndescription: Review files\n---\nReview $FILE.\n",
        });
        const candidate = requiredCandidate(result.candidates, "Workflow");
        const input = nativeInput(candidate);
        expect(validateCodexNativeDialect(input)).toBe(true);
        expect(nativeContract("codex-custom-prompt-markdown-v1").validateSameContent(input)).toBe(true);

        const contract = codexProvider.dialectContracts.portableEntries.find(
            (item) => item.definition.dialectId === "codex-custom-prompt-markdown-v1",
        );
        if (contract === undefined) throw new Error("missing Codex Workflow entry dialect");
        const portable: PortableEntryDialectValidationInputV1 = {
            use: {
                kind: "Workflow",
                field: "workflow_instruction",
                dialectId: "codex-custom-prompt-markdown-v1",
                logicalPath: "WORKFLOW.md",
            },
            versionStatus: "complete",
            canonical: { kind: "Workflow", typeData: candidate.typeData },
            canonicalFiles: input.canonicalFiles,
        };
        expect(contract.validateCanonicalEntry(portable)).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_CLI", versionText: "fixture" })).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_APP", versionText: "fixture" })).toBe(false);
        portable.canonicalFiles = [];
        expect(contract.validateCanonicalEntry(portable)).toBe(false);
        portable.versionStatus = "incomplete";
        expect(contract.validateCanonicalEntry(portable)).toBe(true);
    });

    it("validates Codex model and effort selectors without inventing a relative tier", () => {
        for (const [field, dialectId] of [
            ["subagent_model", "codex-subagent-model-v1"],
            ["subagent_effort", "codex-subagent-reasoning-effort-v1"],
        ] as const) {
            const contract = codexProvider.dialectContracts.portableSelectors.find(
                (item) => item.definition.dialectId === dialectId,
            );
            if (contract === undefined) throw new Error(`missing ${dialectId}`);
            const use = {
                kind: "Subagent" as const,
                field,
                dialectId,
                value: { valueKind: "relative_tier" as const, selector: "fixture", relativeTier: -1 as const },
            };
            expect(contract.validateSelector(use)).toBe(true);
            expect(contract.validateSelector({ ...use, value: { ...use.value, relativeTier: 1 } })).toBe(false);
            expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_APP", versionText: "fixture" })).toBe(true);
            expect(contract.validateSourceApplicability({ agentRuntimeId: "OPENCODE_CLI", versionText: "fixture" })).toBe(false);
        }
    });
});

function requiredCandidate<K extends AdapterExtractedAssetCandidate["kind"]>(
    candidates: AdapterExtractedAssetCandidate[],
    kind: K,
): Extract<AdapterExtractedAssetCandidate, { kind: K }> {
    const candidate = candidates.find((item): item is Extract<AdapterExtractedAssetCandidate, { kind: K }> => item.kind === kind);
    if (candidate === undefined) throw new Error(`missing ${kind} candidate`);
    return candidate;
}

function nativeContract(dialectId: string) {
    const contract = codexProvider.dialectContracts.native.find((item) => item.definition.dialectId === dialectId);
    if (contract === undefined) throw new Error(`missing ${dialectId}`);
    return contract;
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("Codex fixture must preserve a separate native graph");
    }
    return {
        canonical: { kind: candidate.kind, typeData: candidate.typeData } as NativeDialectValidationInputV1["canonical"],
        canonicalFiles: candidate.files.map((file, index) => {
            const manifest = {
                fileId: uuidFor(index),
                logicalPath: file.logicalPath,
                role: file.role,
                contentHash: DIGEST,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                byteSize: file.contentKind === "text" ? Buffer.byteLength(file.text, "utf8") : file.bytes.byteLength,
                executable: file.executable,
                references: file.references ?? [],
            };
            return file.contentKind === "text"
                ? { file: manifest, contentKind: "text" as const, text: file.text.replace(/\r\n/g, "\n") }
                : { file: manifest, contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
        }),
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

function uuidFor(index: number): UuidV4 {
    return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as UuidV4;
}
