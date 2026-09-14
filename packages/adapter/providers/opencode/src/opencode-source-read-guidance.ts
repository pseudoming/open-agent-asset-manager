/** OpenCode Guidance source candidate builder and fallback precedence. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic } from "@oaam/core";
import {
    basenamePath,
    candidateBase,
    candidateIdFor,
    compareText,
    metadataOrigins,
    readDiagnostic,
    rejectNonUtf8,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./opencode-source-read-foundation";
import {
    OPENCODE_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./opencode-source-read-model";

export function buildGuidanceCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const ordered = [...scan.files].sort(
        (left, right) =>
            guidancePriority(left.relativePath) - guidancePriority(right.relativePath) ||
            compareText(left.relativePath, right.relativePath),
    );
    const file = ordered[0];
    const blockingUnreadable = [...scan.unreadableRelativePaths]
        .sort((left, right) => guidancePriority(left) - guidancePriority(right) || compareText(left, right))
        .find((path) => file === undefined || guidancePriority(path) <= guidancePriority(file.relativePath));
    if (blockingUnreadable !== undefined) {
        diagnostics.push(
            readDiagnostic(
                "opencode.guidance_preferred_source_unreadable",
                "A preferred OpenCode Guidance source exists but could not be read; fallback is blocked",
                "partial",
                "error",
                blockingUnreadable,
            ),
        );
        return { candidates, diagnostics, ignoredSource: true };
    }
    for (const shadowed of ordered.slice(1)) {
        scan.ignoreRecord(shadowed, "shadowed_guidance_source");
        ignoredSource = true;
    }
    if (file === undefined) return { candidates, diagnostics, ignoredSource };
    if (file.text === null) {
        rejectNonUtf8(scan, file, "Guidance", diagnostics);
        return { candidates, diagnostics, ignoredSource: true };
    }
    if (file.text.trim() === "") {
        scan.ignoreRecord(file, "empty_guidance");
        return { candidates, diagnostics, ignoredSource: true };
    }
    const candidateId = candidateIdFor("Guidance", scan, file.relativePath);
    const candidate: AdapterExtractedAssetCandidate = {
        ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
        displayName: basenamePath(file.relativePath || "AGENTS.md"),
        displayDescription: "",
        files: [
            {
                ...textEntry("GUIDANCE.md", file.text),
                references: [],
            },
        ],
        nativeRepresentation: separateNative(OPENCODE_NATIVE_DIALECTS.guidance, [file]),
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "default_promotable",
        sourceFileOrigins: [
            {
                logicalPath: "GUIDANCE.md",
                observedReadEntryIds: [file.observedReadEntryId],
            },
        ],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, false),
        sourceEvidence: sourceEvidence(scan, file, "opencode_guidance"),
        diagnostics: [],
        kind: "Guidance",
        typeData: { schemaVersion: 1 },
    };
    scan.attachCandidate(candidateId, [file]);
    candidates.push(candidate);
    return { candidates, diagnostics, ignoredSource };
}

function guidancePriority(relativePath: string): number {
    if (relativePath === "AGENTS.md") return 0;
    if (relativePath === "CLAUDE.md") return 1;
    if (relativePath === "CONTEXT.md") return 2;
    return 3;
}
