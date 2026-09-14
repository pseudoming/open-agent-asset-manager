/** Cursor project Subagent Markdown candidate builder. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic } from "@oaam/core";
import {
    cursorCandidateBase,
    cursorCandidateId,
    cursorSourceEvidence,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    textEntry,
} from "./cursor-source-read-foundation";
import {
    CURSOR_NATIVE_DIALECTS,
    type CursorCandidateBuildResult,
    type CursorScanResult,
    type CursorSourceContext,
} from "./cursor-source-read-model";
import { parseCursorMarkdownSubagent } from "./cursor-subagent-markdown";

export function buildCursorSubagentCandidates(context: CursorSourceContext, scan: CursorScanResult): CursorCandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            scan.ignoreRecord(file, "cursor_subagent_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "cursor.subagent_not_utf8",
                    "Cursor Subagent declarations must be valid UTF-8 text",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const parsed = parseCursorMarkdownSubagent(file.text, file.relativePath);
        if (parsed.disposition === "ignored") {
            scan.ignoreRecord(file, "cursor_subagent_invalid");
            diagnostics.push(...parsed.diagnostics);
            ignoredSource = true;
            continue;
        }
        const complete = parsed.diagnostics.every((item) => item.severity !== "error");
        const candidateId = cursorCandidateId("Subagent", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...cursorCandidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: parsed.name,
            displayDescription: parsed.description,
            files: [textEntry("instructions.json", JSON.stringify(parsed.instruction))],
            nativeRepresentation: separateNative(CURSOR_NATIVE_DIALECTS.subagent, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath: "instructions.json", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: cursorSourceEvidence(scan, file, "cursor_project_subagent_markdown"),
            diagnostics: parsed.diagnostics,
            kind: "Subagent",
            typeData: parsed.typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    markDuplicateIdentities(candidates);
    return { candidates, diagnostics, ignoredSource };
}

function markDuplicateIdentities(candidates: AdapterExtractedAssetCandidate[]): void {
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate.displayName, (counts.get(candidate.displayName) ?? 0) + 1);
    for (const candidate of candidates) {
        if ((counts.get(candidate.displayName) ?? 0) < 2) continue;
        candidate.status = "incomplete";
        candidate.assetCandidateStatus = "incomplete";
        candidate.diagnostics.push(
            readDiagnostic(
                "cursor.subagent_duplicate_identity",
                "Multiple Cursor Subagent declarations in this Project use the same name",
                "conflict",
                "error",
                candidate.displayName,
            ),
        );
    }
}
