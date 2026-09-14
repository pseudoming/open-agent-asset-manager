/** Cursor project Guidance and `.mdc` Rule candidate builders. */

import {
    isPortableSourcePattern,
    projectBoundedFrontmatterDiagnostics,
    trimNonBlankText,
    unknownSourceKeys,
} from "@oaam/adapter-framework";
import type { AdapterExtractedAssetCandidate, OperationDiagnostic, RuleTypeDataV2 } from "@oaam/core";
import { cursorFrontmatterBoolean, cursorFrontmatterString, parseCursorFrontmatter } from "./cursor-frontmatter";
import {
    basename,
    cursorCandidateBase,
    cursorCandidateId,
    cursorSourceEvidence,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    textEntry,
    withoutExtension,
} from "./cursor-source-read-foundation";
import {
    CURSOR_NATIVE_DIALECTS,
    type CursorCandidateBuildResult,
    type CursorScanResult,
    type CursorSourceContext,
} from "./cursor-source-read-model";

export interface ParsedCursorRule {
    body: string;
    typeData: RuleTypeDataV2;
    diagnostics: OperationDiagnostic[];
}

export function buildCursorGuidanceCandidates(context: CursorSourceContext, scan: CursorScanResult): CursorCandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            scan.ignoreRecord(file, "cursor_guidance_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "cursor.guidance_not_utf8",
                    "Cursor Guidance must be valid UTF-8 text",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        if (file.text.trim() === "") {
            scan.ignoreRecord(file, "cursor_guidance_empty");
            ignoredSource = true;
            continue;
        }
        const candidateId = cursorCandidateId("Guidance", scan, file.relativePath);
        const localPrivate = basename(file.relativePath) === "CLAUDE.local.md";
        const candidate: AdapterExtractedAssetCandidate = {
            ...cursorCandidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: basename(file.relativePath),
            displayDescription: localPrivate ? "Cursor local/private project guidance" : "",
            files: [textEntry("GUIDANCE.md", file.text)],
            nativeRepresentation: separateNative(CURSOR_NATIVE_DIALECTS.guidance, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety: localPrivate ? "requires_user_confirmation" : "default_promotable",
            sourceFileOrigins: [{ logicalPath: "GUIDANCE.md", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, false),
            sourceEvidence: cursorSourceEvidence(scan, file, "cursor_guidance"),
            diagnostics: [],
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function buildCursorRuleCandidates(context: CursorSourceContext, scan: CursorScanResult): CursorCandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            scan.ignoreRecord(file, "cursor_rule_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "cursor.rule_not_utf8",
                    "Cursor Rule declarations must be valid UTF-8 text",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const parsed = parseCursorRule(file.text, file.relativePath);
        const complete = parsed.body.trim() !== "" && parsed.diagnostics.every((item) => item.severity !== "error");
        const candidateId = cursorCandidateId("Rule", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...cursorCandidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: parsed.typeData.name,
            displayDescription: parsed.typeData.description,
            files: [textEntry("RULE.md", parsed.body)],
            nativeRepresentation: separateNative(CURSOR_NATIVE_DIALECTS.rule, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath: "RULE.md", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: cursorSourceEvidence(scan, file, "cursor_rule_mdc"),
            diagnostics: parsed.diagnostics,
            kind: "Rule",
            typeData: parsed.typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function parseCursorRule(text: string, relativePath: string): ParsedCursorRule {
    const parsed = parseCursorFrontmatter(text);
    const diagnostics = projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "cursor.rule_frontmatter_unclosed",
                "Cursor Rule frontmatter is not closed",
                "invalid_schema",
                "error",
                relativePath,
            ),
        (message) => readDiagnostic("cursor.rule_frontmatter_invalid", message, "invalid_schema", "error", relativePath),
    );
    const unknown = unknownSourceKeys(parsed, ["description", "globs", "alwaysApply"]);
    if (unknown.length > 0) {
        diagnostics.push(
            readDiagnostic(
                "cursor.rule_frontmatter_unsupported",
                `Cursor Rule has unsupported frontmatter fields: ${unknown.join(", ")}`,
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }
    const description = cursorFrontmatterString(parsed, "description") ?? "";
    const alwaysApply = cursorFrontmatterBoolean(parsed, "alwaysApply");
    const glob = trimNonBlankText(cursorFrontmatterString(parsed, "globs"));
    if (alwaysApply === undefined) {
        diagnostics.push(
            readDiagnostic(
                "cursor.rule_always_apply_missing",
                "Cursor Rule alwaysApply must be an explicit boolean",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }
    if (glob !== undefined && !isPortableSourcePattern(glob)) {
        diagnostics.push(
            readDiagnostic(
                "cursor.rule_glob_invalid",
                "Cursor Rule globs must be one bounded portable pattern",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }
    if (alwaysApply === true && glob !== undefined) {
        diagnostics.push(
            readDiagnostic(
                "cursor.rule_always_with_glob_ambiguous",
                "Cursor Rule cannot be both always-on and path-selected",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }
    if (alwaysApply === false && glob === undefined && description.trim() === "") {
        diagnostics.push(
            readDiagnostic(
                "cursor.rule_model_description_missing",
                "Model-selected Cursor Rule requires a non-empty description",
                "invalid_schema",
                "error",
                relativePath,
            ),
        );
    }
    const activation: RuleTypeDataV2["activation"] =
        alwaysApply === true
            ? { mode: "always" }
            : glob !== undefined
              ? { mode: "path", globs: [glob] }
              : { mode: "model_decision" };
    return {
        body: parsed.hasFrontmatter && parsed.closed ? parsed.body : text,
        typeData: {
            schemaVersion: 2,
            name: withoutExtension(basename(relativePath)),
            description,
            activation,
        },
        diagnostics,
    };
}
