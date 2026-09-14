/** OpenCode Skill directory candidate builder. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, SkillTypeDataV2 } from "@oaam/core";
import { buildSourceFileGraph } from "@oaam/adapter-framework";
import { parseOpencodeFrontmatter } from "./opencode-frontmatter";
import {
    basenamePath,
    candidateBase,
    candidateIdFor,
    compareText,
    isOwnedBySkillRoot,
    metadataOrigins,
    nonBlank,
    nonUtf8Diagnostic,
    parentPath,
    parseMarkdownReferences,
    readDiagnostic,
    relativeWithin,
    separateNative,
    sourceEvidence,
} from "./opencode-source-read-foundation";
import {
    frontmatterDiagnostics,
    optionalBoolean,
    optionalString,
    stringMap,
    unknownFieldDiagnostic,
    unknownKeys,
} from "./opencode-source-read-fields";
import { reportManifestFiles } from "./opencode-source-read-jsonc";
import {
    opencodeSkillDialect,
    opencodeSkillEntryDialect,
    type OpencodeSkillInterpretation,
    type CandidateBuildResult,
    type DirectoryRecord,
    type FileRecord,
    type ScanResult,
    type SourceContext,
} from "./opencode-source-read-model";

export function buildSkillCandidates(
    context: SourceContext,
    scan: ScanResult,
    interpretation: OpencodeSkillInterpretation = scan.capability.agentRuntimeId === "OPENCODE_CLI" ? 2 : 1,
): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = reportManifestFiles(scan, "Skill", diagnostics);
    const entries = scan.files
        .filter((file) => basenamePath(file.relativePath) === "SKILL.md")
        .sort((left, right) => compareText(left.relativePath, right.relativePath));
    const skillRoots = entries.map((entry) => parentPath(entry.relativePath));
    for (const entry of entries) {
        const folder = parentPath(entry.relativePath);
        const folderRecord = scan.directories.find((directory) => directory.relativePath === folder);
        const sourceFiles = scan.files
            .filter((file) => isOwnedBySkillRoot(file.relativePath, folder, skillRoots))
            .sort((left, right) => compareText(left.relativePath, right.relativePath));
        const sourceDirectories = scan.directories
            .filter((directory) => isOwnedBySkillRoot(directory.relativePath, folder, skillRoots))
            .sort((left, right) => compareText(left.relativePath, right.relativePath));
        if (entry.text === null) {
            for (const file of sourceFiles) scan.ignoreRecord(file, "declaration_not_utf8");
            if (folderRecord !== undefined) scan.ignoreRecord(folderRecord, "declaration_not_utf8");
            diagnostics.push(nonUtf8Diagnostic("Skill", entry.relativePath));
            ignoredSource = true;
            continue;
        }
        const parsed = parseOpencodeFrontmatter(entry.text);
        if (parsed.presentKeys.includes("hooks") || parsed.presentKeys.includes("shell")) {
            for (const file of sourceFiles) scan.ignoreRecord(file, "executable_skill_source");
            if (folderRecord !== undefined) scan.ignoreRecord(folderRecord, "executable_skill_source");
            diagnostics.push(
                readDiagnostic(
                    "opencode.skill_executable_source_rejected",
                    "Skill hooks/shell declarations are not collected as portable user assets",
                    "unsupported",
                    "error",
                    entry.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const candidateDiagnostics = frontmatterDiagnostics(parsed, entry.relativePath);
        const unknown = unknownKeys(parsed, ["name", "description", "slash", "license", "compatibility", "metadata"]);
        if (unknown.length > 0) candidateDiagnostics.push(unknownFieldDiagnostic("Skill", unknown, entry.relativePath));
        const name = nonBlank(optionalString(parsed, "name", candidateDiagnostics, entry.relativePath, "Skill"));
        const description = nonBlank(optionalString(parsed, "description", candidateDiagnostics, entry.relativePath, "Skill"));
        if (name === undefined || description === undefined || parsed.body.trim() === "") {
            for (const file of sourceFiles) scan.ignoreRecord(file, "invalid_skill_source");
            if (folderRecord !== undefined) scan.ignoreRecord(folderRecord, "invalid_skill_source");
            diagnostics.push(
                readDiagnostic(
                    "opencode.skill_required_content_missing",
                    "Skill requires explicit non-empty name, description, and body",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const metadata = stringMap(parsed, "metadata", candidateDiagnostics, entry.relativePath, "Skill");
        const slash = optionalBoolean(parsed, "slash", candidateDiagnostics, entry.relativePath, "Skill");
        const typeData: SkillTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            whenToUse: "",
            entryDialectId: opencodeSkillEntryDialect(interpretation),
            portableMetadata: {
                license: optionalString(parsed, "license", candidateDiagnostics, entry.relativePath, "Skill") ?? "",
                compatibility: optionalString(parsed, "compatibility", candidateDiagnostics, entry.relativePath, "Skill") ?? "",
                metadata,
            },
            invocation: {
                pathCondition: { mode: "none" },
                user:
                    interpretation === 2 || slash === true
                        ? { mode: "direct", commandName: name }
                        : { mode: "not_directly_invocable" },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: {
                mode: "caller",
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
            },
        };
        const canonicalGraph = buildSourceFileGraph({
            sourceFiles,
            entry,
            entryText: parsed.body,
            preserveEntryExecutable: false,
            logicalPathFor: (file) => relativeWithin(file.relativePath, folder),
            referencesFor: parseMarkdownReferences,
        });
        const canonicalFiles = canonicalGraph.files;
        const complete =
            parsed.hasFrontmatter && parsed.closed && candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor(
            "Skill",
            scan,
            folder || entry.relativePath,
            interpretation === 2 ? opencodeSkillDialect(interpretation) : undefined,
        );
        const originRecords: Array<FileRecord | DirectoryRecord> = [...sourceFiles, ...sourceDirectories];
        const nativeDirectories = sourceDirectories.filter((directory) => directory.relativePath !== "");
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, folder, entry.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: canonicalFiles,
            nativeRepresentation:
                nativeDirectories.length === 0
                    ? separateNative(opencodeSkillDialect(interpretation), sourceFiles)
                    : separateNative(opencodeSkillDialect(interpretation), sourceFiles, nativeDirectories),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: canonicalGraph.sourceFileOrigins,
            sourceContainerEntryIds: sourceDirectories.map((directory) => directory.observedReadEntryId).sort(compareText),
            metadataSourceOrigins: metadataOrigins(entry.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, entry, "opencode_skill_directory"),
            diagnostics: candidateDiagnostics,
            kind: "Skill",
            typeData,
        };
        scan.attachCandidate(candidateId, originRecords);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
