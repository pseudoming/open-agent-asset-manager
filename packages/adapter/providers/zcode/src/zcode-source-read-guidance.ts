/** ZCode global/project AGENTS.md candidate mapping. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic } from "@oaam/core";
import {
    candidateBase,
    candidateIdFor,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./zcode-source-read-foundation";
import { ZCODE_NATIVE_DIALECTS, type ZcodeScanResult, type ZcodeSourceContext } from "./zcode-source-read-model";

export function buildGuidanceCandidates(context: ZcodeSourceContext, scan: ZcodeScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.executable) {
            scan.ignoreRecord(file, "executable_guidance_rejected");
            diagnostics.push(
                readDiagnostic(
                    "zcode.guidance_executable_rejected",
                    "Executable ZCode Guidance is not importable",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        if (file.text === null) {
            scan.ignoreRecord(file, "guidance_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "zcode.guidance_not_utf8",
                    "ZCode Guidance must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        if (file.text.trim() === "") {
            scan.ignoreRecord(file, "empty_guidance");
            ignoredSource = true;
            continue;
        }
        const candidateId = candidateIdFor("Guidance", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file),
            displayDescription: context.scope === "global" ? "ZCode global Guidance" : "ZCode project Guidance",
            files: [{ ...textEntry("GUIDANCE.md", file.text), references: [] }],
            nativeRepresentation: separateNative(ZCODE_NATIVE_DIALECTS.guidance, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath: "GUIDANCE.md", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, false),
            sourceEvidence: sourceEvidence(scan, file, "zcode_guidance"),
            diagnostics: [],
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
