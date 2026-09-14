/** Codex runtime-consolidated final Memory projection. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic } from "@oaam/core";
import {
    candidateBase,
    candidateIdFor,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./codex-source-read-foundation";
import { CODEX_NATIVE_DIALECTS, type CodexCandidateBuilder, type CodexFileRecord } from "./codex-source-read-model";

const MEMORY_PATH = "memories/MEMORY.md";
const SUMMARY_PATH = "memories/memory_summary.md";

export const buildMemoryCandidates: CodexCandidateBuilder = (context, scan) => {
    const memory = scan.files.find((file) => file.relativePath === MEMORY_PATH);
    const summary = scan.files.find((file) => file.relativePath === SUMMARY_PATH);
    const observed = [memory, summary].filter((file): file is CodexFileRecord => file !== undefined);
    const diagnostics: OperationDiagnostic[] = [];
    const invalid = validateMemoryPair(memory, summary, diagnostics);
    if (invalid) {
        for (const file of observed) scan.ignoreRecord(file, "invalid_codex_consolidated_memory_pair");
        return { candidates: [], diagnostics, ignoredSource: observed.length > 0 };
    }
    if (memory === undefined || summary === undefined || memory.text === null || summary.text === null) {
        return { candidates: [], diagnostics, ignoredSource: false };
    }

    const directory = scan.directories.find((entry) => entry.relativePath === "memories");
    const candidateId = candidateIdFor("Memory", scan, MEMORY_PATH);
    const candidate: AdapterExtractedAssetCandidate = {
        ...candidateBase(context, scan, candidateId, MEMORY_PATH, memory.observedReadEntryId),
        displayName: "Codex Memory",
        displayDescription: "Runtime-consolidated Codex memory",
        files: [textEntry("memory.md", memory.text)],
        nativeRepresentation: separateNative(CODEX_NATIVE_DIALECTS.memory, [memory, summary]),
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "requires_user_confirmation",
        sourceFileOrigins: [{ logicalPath: "memory.md", observedReadEntryIds: [memory.observedReadEntryId] }],
        sourceContainerEntryIds: directory === undefined ? [] : [directory.observedReadEntryId],
        metadataSourceOrigins: metadataOrigins(memory.observedReadEntryId, false),
        sourceEvidence: [
            ...sourceEvidence(scan, memory, "codex_consolidated_memory"),
            ...sourceEvidence(scan, summary, "codex_memory_summary"),
        ],
        diagnostics: [],
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "unit",
            card: { name: "Codex Memory", description: "Runtime-consolidated Codex memory" },
            loading: { card: "high", body: "low" },
            applicabilityRule: "",
        },
    };
    scan.attachCandidate(candidateId, directory === undefined ? [memory, summary] : [directory, memory, summary]);
    return { candidates: [candidate], diagnostics, ignoredSource: false };
};

function validateMemoryPair(
    memory: CodexFileRecord | undefined,
    summary: CodexFileRecord | undefined,
    diagnostics: OperationDiagnostic[],
): boolean {
    if (memory === undefined && summary === undefined) return false;
    let invalid = false;
    if (memory === undefined || summary === undefined) {
        diagnostics.push(
            readDiagnostic(
                "codex.memory_final_pair_incomplete",
                "Codex Memory requires both final MEMORY.md and memory_summary.md artifacts",
                "partial",
                "error",
                memory?.relativePath ?? summary?.relativePath ?? "memories",
            ),
        );
        invalid = true;
    }
    for (const [file, label] of [
        [memory, "MEMORY.md"],
        [summary, "memory_summary.md"],
    ] as const) {
        if (file !== undefined && file.text === null) {
            diagnostics.push(
                readDiagnostic(
                    "codex.memory_final_artifact_not_utf8",
                    `Codex ${label} must be valid UTF-8`,
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            invalid = true;
        }
    }
    if (memory?.text !== null && memory?.text !== undefined && memory.text.trim() === "") {
        diagnostics.push(
            readDiagnostic(
                "codex.memory_body_empty",
                "Codex MEMORY.md is empty and cannot form an OAAM Memory Unit",
                "invalid_schema",
                "error",
                memory.relativePath,
            ),
        );
        invalid = true;
    }
    if (summary?.text !== null && summary?.text !== undefined && summary.text.split(/\r?\n/u)[0] !== "v1") {
        diagnostics.push(
            readDiagnostic(
                "codex.memory_summary_schema_invalid",
                "Codex memory_summary.md must use the current v1 summary schema",
                "invalid_schema",
                "error",
                summary.relativePath,
            ),
        );
        invalid = true;
    }
    return invalid;
}
