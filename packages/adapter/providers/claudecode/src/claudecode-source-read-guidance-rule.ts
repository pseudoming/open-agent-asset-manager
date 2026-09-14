/** Claude Code Guidance and Rule candidate builders. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, RuleTypeDataV2 } from "@oaam/core";
import { frontmatterString, frontmatterStrings, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import {
    basename,
    candidateBase,
    candidateIdFor,
    frontmatterDiagnostics,
    isPortablePattern,
    metadataOrigins,
    nonBlank,
    parseClaudeIncludes,
    readDiagnostic,
    rejectNonUtf8Declaration,
    separateNative,
    sourceEvidence,
    textEntry,
    uniquePreservingOrder,
    unknownFieldDiagnostic,
    unknownKeys,
    withoutExtension,
} from "./claudecode-source-read-foundation";
import {
    CLAUDECODE_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./claudecode-source-read-model";

export function buildGuidanceCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Guidance", diagnostics);
            ignoredSource = true;
            continue;
        }
        if (file.text.trim() === "") continue;
        const localPrivate = basename(file.relativePath) === "CLAUDE.local.md";
        const candidateId = candidateIdFor("Guidance", scan, file.relativePath);
        const displayName = basename(file.relativePath);
        const nativePath = file.relativePath;
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName,
            displayDescription: localPrivate ? "Claude Code local/private project guidance" : "",
            files: [
                {
                    logicalPath: "GUIDANCE.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: file.text,
                    executable: false,
                    references: parseClaudeIncludes(file.text),
                },
            ],
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.guidance, [{ ...file, relativePath: nativePath }]),
            dialectRestorationTransition: { action: "inherit" },
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety: localPrivate ? "requires_user_confirmation" : "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "GUIDANCE.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, false),
            sourceEvidence: sourceEvidence(scan, file, "claudecode_guidance"),
            diagnostics: [],
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function buildRuleCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Rule", diagnostics);
            ignoredSource = true;
            continue;
        }
        const parsed = parseClaudeFrontmatter(file.text);
        const candidateDiagnostics = frontmatterDiagnostics(parsed, file.relativePath);
        const pathValues = frontmatterStrings(parsed, "paths");
        const invalidPaths =
            parsed.presentKeys.includes("paths") &&
            (pathValues === undefined || pathValues.length === 0 || pathValues.some((value) => !isPortablePattern(value)));
        if (invalidPaths) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.rule_paths_invalid",
                    "Rule paths must be a non-empty string/list",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const unknown = unknownKeys(parsed, ["name", "description", "paths"]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Rule", unknown, file.relativePath));
        }
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
        const name = nonBlank(frontmatterString(parsed, "name")) ?? withoutExtension(basename(file.relativePath));
        const typeData: RuleTypeDataV2 = {
            schemaVersion: 2,
            name,
            description: frontmatterString(parsed, "description") ?? "",
            activation:
                pathValues !== undefined && pathValues.length > 0
                    ? { mode: "path", globs: uniquePreservingOrder(pathValues) }
                    : { mode: "always" },
        };
        const candidateId = candidateIdFor("Rule", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: typeData.description,
            files: [textEntry("RULE.md", body)],
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.rule, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "RULE.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, file, parsed.hasFrontmatter ? "frontmatter" : "document"),
            diagnostics: candidateDiagnostics,
            kind: "Rule",
            typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
