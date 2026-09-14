import type { AdapterExtractedAssetCandidate, NativeDialectValidationInputV1, UuidV4 } from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { describe, expect, it } from "vitest";
import { codexProvider } from "../src/codex-provider";
import { validateCodexNativeDialect } from "../src/codex-source-read-native";
import { configRoot, DIGEST, readMemory } from "./codex-source-test-fixtures";

const MEMORY = "# Project memory\n\nUse cobalt receipts.\n";
const SUMMARY = "v1\n\n## What's in Memory\n- cobalt receipts\n";

describe("Codex consolidated Memory source", () => {
    it("imports only the validated final pair as one Global Memory Unit and preserves both native files", async () => {
        const result = await readMemory(configRoot(), {
            "memories/MEMORY.md": MEMORY,
            "memories/memory_summary.md": SUMMARY,
            "memories/raw_memories.md": "runtime-private workbench\n",
            "memories/rollout_summaries/private.md": "runtime-private rollout\n",
            "memories/.git/config": "runtime-owned baseline\n",
            "memories_1.sqlite": new Uint8Array([0x53, 0x51, 0x4c]),
            "sessions/private.jsonl": "excluded transcript\n",
        });
        expect(result.diagnostics).toEqual([]);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Memory",
                scope: "global",
                projectRootPath: "",
                displayName: "Codex Memory",
                displayDescription: "Runtime-consolidated Codex memory",
                status: "complete",
                assetCandidateStatus: "importable",
                promotionSafety: "requires_user_confirmation",
                files: [expect.objectContaining({ logicalPath: "memory.md", text: MEMORY })],
                nativeRepresentation: expect.objectContaining({
                    dialectId: "codex-consolidated-memory-v1",
                    files: [
                        expect.objectContaining({ relativePath: "memories/MEMORY.md" }),
                        expect.objectContaining({ relativePath: "memories/memory_summary.md" }),
                    ],
                }),
                sourceFileOrigins: [
                    expect.objectContaining({ logicalPath: "memory.md", observedReadEntryIds: [expect.any(String)] }),
                ],
                sourceContainerEntryIds: [expect.any(String)],
                sourceEvidence: [
                    expect.objectContaining({ value: expect.stringContaining("codex_consolidated_memory") }),
                    expect.objectContaining({ value: expect.stringContaining("codex_memory_summary") }),
                ],
                typeData: {
                    schemaVersion: 2,
                    entityRole: "unit",
                    card: { name: "Codex Memory", description: "Runtime-consolidated Codex memory" },
                    loading: { card: "high", body: "low" },
                    applicabilityRule: "",
                },
            }),
        ]);
        const candidate = result.candidates[0];
        if (candidate === undefined) throw new Error("missing Memory candidate");
        const input = nativeInput(candidate);
        expect(validateCodexNativeDialect(input)).toBe(true);
        const contract = codexProvider.dialectContracts.native.find(
            (row) => row.definition.dialectId === "codex-consolidated-memory-v1",
        );
        expect(contract?.validateSameContent(input)).toBe(true);

        const changedSummary = structuredClone(input);
        changedSummary.nativeFiles[1] = {
            relativePath: "memories/memory_summary.md",
            bytes: Buffer.from(SUMMARY.replace("cobalt", "amber")),
        };
        expect(validateCodexNativeDialect(changedSummary)).toBe(false);

        const missingSummary = structuredClone(input);
        missingSummary.representation.files = missingSummary.representation.files.slice(0, 1);
        missingSummary.nativeFiles = missingSummary.nativeFiles.slice(0, 1);
        expect(validateCodexNativeDialect(missingSummary)).toBe(false);
    });

    it("fails closed for incomplete, non-UTF-8, empty, or wrong-schema final artifacts", async () => {
        const cases: Array<[Record<string, string | Uint8Array>, string]> = [
            [{ "memories/MEMORY.md": MEMORY }, "codex.memory_final_pair_incomplete"],
            [{ "memories/memory_summary.md": SUMMARY }, "codex.memory_final_pair_incomplete"],
            [
                { "memories/MEMORY.md": new Uint8Array([0xff]), "memories/memory_summary.md": SUMMARY },
                "codex.memory_final_artifact_not_utf8",
            ],
            [{ "memories/MEMORY.md": " \n", "memories/memory_summary.md": SUMMARY }, "codex.memory_body_empty"],
            [{ "memories/MEMORY.md": MEMORY, "memories/memory_summary.md": "outdated\n" }, "codex.memory_summary_schema_invalid"],
        ];
        for (const [files, code] of cases) {
            const result = await readMemory(configRoot(), files);
            expect(result.candidates, code).toEqual([]);
            expect(result.diagnostics, code).toContainEqual(expect.objectContaining({ code }));
        }
    });

    it("ignores private workbench state when the final pair is absent", async () => {
        const result = await readMemory(configRoot(), {
            "memories/raw_memories.md": "private\n",
            "memories_1.sqlite": new Uint8Array([0x01]),
        });
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toEqual([]);
        expect(result.sourceParseReports).toEqual([expect.objectContaining({ status: "skipped_ignored_source" })]);
    });
});

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("Codex Memory fixture must preserve a separate native graph");
    }
    return {
        canonical: { kind: candidate.kind, typeData: candidate.typeData } as NativeDialectValidationInputV1["canonical"],
        canonicalFiles: candidate.files.map((file, index) => {
            if (file.contentKind !== "text") throw new Error("Codex Memory canonical entry must be text");
            return {
                file: {
                    fileId: uuidFor(index),
                    logicalPath: file.logicalPath,
                    role: file.role,
                    contentHash: DIGEST,
                    contentKind: "text" as const,
                    mediaType: file.mediaType,
                    byteSize: Buffer.byteLength(file.text, "utf8"),
                    executable: file.executable,
                    references: file.references ?? [],
                },
                contentKind: "text" as const,
                text: file.text,
            };
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
