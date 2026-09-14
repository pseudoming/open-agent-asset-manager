/** Skill folder/flat-source candidate builder. */

import { buildSourceFileGraph } from "@oaam/adapter-framework";
import type { AdapterExtractedAssetCandidate, OperationDiagnostic, SkillTypeDataV2 } from "@oaam/core";
import {
    antigravityFrontmatterString,
    antigravityFrontmatterStringMap,
    parseAntigravityFrontmatter,
} from "./antigravity-frontmatter";
import {
    basenamePath,
    candidateBase,
    candidateIdFor,
    compareText,
    frontmatterDiagnostics,
    frontmatterStringDiagnostics,
    isFlatSkillEntry,
    isFolderSkillEntry,
    isWithin,
    metadataOrigins,
    nonBlank,
    parentPath,
    parseMarkdownReferences,
    readDiagnostic,
    rejectNonUtf8Declaration,
    separateNative,
    skillLogicalPath,
    sourceEvidence,
    unknownFieldDiagnostic,
    unknownKeys,
} from "./antigravity-source-read-foundation";
import {
    ANTIGRAVITY_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./antigravity-source-read-model";
import { sourceBases } from "./antigravity-source-read-scan";

export function buildSkillCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const bases = sourceBases("Skill", context.layout);
    const entryFiles = scan.files.filter(
        (file) => isFolderSkillEntry(file.relativePath, bases) || isFlatSkillEntry(file.relativePath, bases),
    );
    for (const entry of entryFiles) {
        if (entry.text === null) {
            rejectNonUtf8Declaration(scan, entry, "Skill", diagnostics);
            ignoredSource = true;
            continue;
        }
        const folder = basenamePath(entry.relativePath) === "SKILL.md" ? parentPath(entry.relativePath) : null;
        const originFiles = folder === null ? [entry] : scan.files.filter((file) => isWithin(file.relativePath, folder));
        const originDirectories =
            folder === null ? [] : scan.directories.filter((directory) => isWithin(directory.relativePath, folder));
        const parsed = parseAntigravityFrontmatter(entry.text);
        if (parsed.presentKeys.includes("hooks") || parsed.presentKeys.includes("shell")) {
            for (const record of [...originFiles, ...originDirectories]) {
                scan.ignoreRecord(record, "executable_skill_source");
            }
            ignoredSource = true;
            diagnostics.push(
                readDiagnostic(
                    "antigravity.skill_executable_source_rejected",
                    "Skill hooks/shell declarations are not collected as portable user assets",
                    "unsupported",
                    "error",
                    entry.relativePath,
                ),
            );
            continue;
        }
        const candidateDiagnostics = [
            ...frontmatterDiagnostics(parsed, entry.relativePath),
            ...frontmatterStringDiagnostics(
                parsed,
                ["name", "description", "license", "compatibility"],
                "Skill",
                entry.relativePath,
            ),
        ];
        const unknown = unknownKeys(parsed, ["name", "description", "license", "compatibility", "metadata"]);
        if (unknown.includes("trigger"))
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.skill_trigger_frontmatter_unverified",
                    "Antigravity Skill trigger frontmatter is not verified as a Skill declaration field",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
        const otherUnknown = unknown.filter((key) => key !== "trigger");
        if (otherUnknown.length > 0) candidateDiagnostics.push(unknownFieldDiagnostic("Skill", otherUnknown, entry.relativePath));
        const name = nonBlank(antigravityFrontmatterString(parsed, "name"));
        const description = nonBlank(antigravityFrontmatterString(parsed, "description"));
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : entry.text;
        if (!parsed.hasFrontmatter || !parsed.closed || name === undefined || description === undefined || body.trim() === "") {
            for (const record of [...originFiles, ...originDirectories]) {
                scan.ignoreRecord(record, "invalid_skill_source");
            }
            ignoredSource = true;
            diagnostics.push(
                ...candidateDiagnostics,
                readDiagnostic(
                    "antigravity.skill_required_content_missing",
                    "Skill was skipped because explicit name, description, closed frontmatter, and body are required",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
            continue;
        }
        const metadata = antigravityFrontmatterStringMap(parsed, "metadata");
        if (parsed.presentKeys.includes("metadata") && metadata === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.skill_metadata_invalid",
                    "Skill metadata must be a string-to-string map",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
        }
        const canonicalGraph = buildSourceFileGraph({
            sourceFiles: originFiles,
            entry,
            entryText: body,
            preserveEntryExecutable: true,
            logicalPathFor: (file) => skillLogicalPath(file, folder),
            referencesFor: parseMarkdownReferences,
        });
        const canonicalFiles = canonicalGraph.files;
        const typeData: SkillTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            whenToUse: description,
            entryDialectId: "antigravity-skill-markdown-v1",
            portableMetadata: {
                license: antigravityFrontmatterString(parsed, "license") ?? "",
                compatibility: antigravityFrontmatterString(parsed, "compatibility") ?? "",
                metadata: metadata ?? {},
            },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: name },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: {
                preapproved: [],
                denied: [],
                otherwise: "inherit_agent_runtime_policy",
            },
            execution: {
                mode: "caller",
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
            },
        };
        const complete = candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Skill", scan, entry.relativePath);
        const dialectId = folder === null ? ANTIGRAVITY_NATIVE_DIALECTS.skillFlat : ANTIGRAVITY_NATIVE_DIALECTS.skillFolder;
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, entry.relativePath, entry.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: canonicalFiles,
            nativeRepresentation:
                folder === null
                    ? separateNative(dialectId, originFiles)
                    : separateNative(dialectId, originFiles, originDirectories),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: canonicalGraph.sourceFileOrigins,
            sourceContainerEntryIds: originDirectories.map((directory) => directory.observedReadEntryId).sort(compareText),
            metadataSourceOrigins: metadataOrigins(entry.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, entry, "frontmatter", folder === null ? "skill_flat" : "skill_folder"),
            diagnostics: candidateDiagnostics,
            kind: "Skill",
            typeData,
        };
        scan.attachCandidate(candidateId, [...originFiles, ...originDirectories]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
