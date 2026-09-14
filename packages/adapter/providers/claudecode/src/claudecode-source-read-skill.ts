/** Claude Code Skill graph candidate builder. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, SkillTypeDataV2 } from "@oaam/core";
import { buildSourceFileGraph } from "@oaam/adapter-framework";
import { containsExecutablePromptSubstitution, frontmatterString, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import {
    CLAUDECODE_EFFORT_DIALECT,
    CLAUDECODE_MODEL_DIALECT,
    claudeBooleanFrontmatter,
    claudeExecutionAgent,
    claudeForkContext,
    claudeOptionalString,
    claudeStringList,
    claudeStringMap,
    claudeToolStrings,
    effortTier,
    isClaudeRuntimeNativeAgent,
    modelTier,
    selectorTier,
    toolSelectorKey,
    toolSelectors,
} from "./claudecode-source-read-fields";
import {
    basename,
    candidateBase,
    candidateIdFor,
    compareText,
    frontmatterDiagnostics,
    isPortablePattern,
    isWithin,
    metadataOrigins,
    nonBlank,
    nonUtf8DeclarationDiagnostic,
    parentPath,
    parseMarkdownReferences,
    readDiagnostic,
    relativeWithin,
    separateNative,
    sourceEvidence,
    uniquePreservingOrder,
    unknownFieldDiagnostic,
    unknownKeys,
} from "./claudecode-source-read-foundation";
import {
    CLAUDECODE_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type DirectoryRecord,
    type FileRecord,
    type ScanResult,
    type SourceContext,
} from "./claudecode-source-read-model";
import { isDirectSkillEntry } from "./claudecode-source-read-scan";

export function buildSkillCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const entries = scan.files.filter((file) => isDirectSkillEntry(file.relativePath, context.layout));
    for (const entry of entries) {
        const folder = parentPath(entry.relativePath);
        const folderRecord = scan.directories.find((directory) => directory.relativePath === folder);
        const sourceFiles = scan.files
            .filter((file) => isWithin(file.relativePath, folder))
            .sort((left, right) => compareText(left.relativePath, right.relativePath));
        const sourceDirectories = scan.directories
            .filter((directory) => isWithin(directory.relativePath, folder))
            .sort((left, right) => compareText(left.relativePath, right.relativePath));
        if (entry.text === null) {
            for (const file of sourceFiles) scan.ignoreRecord(file, "declaration_not_utf8");
            if (folderRecord !== undefined) {
                scan.ignoreRecord(folderRecord, "declaration_not_utf8");
            }
            diagnostics.push(nonUtf8DeclarationDiagnostic("Skill", entry.relativePath));
            ignoredSource = true;
            continue;
        }
        const parsed = parseClaudeFrontmatter(entry.text);
        if (
            parsed.presentKeys.includes("hooks") ||
            parsed.presentKeys.includes("shell") ||
            containsExecutablePromptSubstitution(parsed.body)
        ) {
            for (const file of sourceFiles) scan.ignoreRecord(file, "executable_skill_source");
            ignoredSource = true;
            diagnostics.push(
                readDiagnostic(
                    "claudecode.skill_executable_source_rejected",
                    "Skill contains hooks, shell selection, or executable prompt substitution and was not collected",
                    "unsupported",
                    "error",
                    entry.relativePath,
                ),
            );
            continue;
        }
        const defaultName = !parsed.presentKeys.includes("name");
        const defaultDescription = !parsed.presentKeys.includes("description");
        const name = defaultName ? nonBlank(basename(folder)) : nonBlank(frontmatterString(parsed, "name"));
        const description = defaultDescription
            ? descriptionFromBody(parsed.body)
            : nonBlank(frontmatterString(parsed, "description"));
        if (
            (parsed.hasFrontmatter && !parsed.closed) ||
            name === undefined ||
            description === undefined ||
            parsed.body.trim() === ""
        ) {
            for (const file of sourceFiles) scan.ignoreRecord(file, "invalid_skill_source");
            if (folderRecord !== undefined) {
                scan.ignoreRecord(folderRecord, "invalid_skill_source");
            }
            diagnostics.push(
                ...frontmatterDiagnostics(parsed, entry.relativePath),
                readDiagnostic(
                    "claudecode.skill_required_content_missing",
                    "Skill requires a non-empty body, valid metadata or its loader defaults, and a closed frontmatter block when present",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const candidateDiagnostics = frontmatterDiagnostics(parsed, entry.relativePath);
        const unknown = unknownKeys(parsed, [
            "name",
            "description",
            "when_to_use",
            "allowed-tools",
            "disallowed-tools",
            "argument-hint",
            "arguments",
            "model",
            "effort",
            "disable-model-invocation",
            "user-invocable",
            "context",
            "agent",
            "paths",
            "license",
            "compatibility",
            "metadata",
            "version",
        ]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Skill", unknown, entry.relativePath));
        }
        const pathPatterns = claudeStringList(parsed, "paths", candidateDiagnostics, entry.relativePath, "Skill") ?? [];
        const pathsValid = pathPatterns.every(isPortablePattern);
        if (!pathsValid) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.skill_paths_invalid",
                    "Skill path patterns must be portable relative patterns",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
        }
        const metadata = claudeStringMap(parsed, "metadata", candidateDiagnostics, entry.relativePath, "Skill") ?? {};
        const preapproved = toolSelectors(
            claudeToolStrings(parsed, "allowed-tools", candidateDiagnostics, entry.relativePath, "Skill") ?? [],
        );
        const denied = toolSelectors(
            claudeToolStrings(parsed, "disallowed-tools", candidateDiagnostics, entry.relativePath, "Skill") ?? [],
        );
        const deniedKeys = new Set(denied.map(toolSelectorKey));
        const filteredPreapproved = preapproved.filter((selector) => !deniedKeys.has(toolSelectorKey(selector)));
        const isolated = claudeForkContext(parsed, candidateDiagnostics, entry.relativePath, "Skill");
        const rawAgent = claudeExecutionAgent(parsed, isolated, candidateDiagnostics, entry.relativePath, "Skill");
        const runtimeNativeAgent = rawAgent === undefined || isClaudeRuntimeNativeAgent(rawAgent);
        if (isolated && rawAgent !== undefined && !runtimeNativeAgent) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.skill_agent_binding_pending",
                    "A user-authored Skill agent selector requires an accepted Subagent Version binding",
                    "conflict",
                    "error",
                    entry.relativePath,
                ),
            );
        }
        const typeData: SkillTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            whenToUse: claudeOptionalString(parsed, "when_to_use", candidateDiagnostics, entry.relativePath, "Skill") ?? "",
            entryDialectId: "claudecode-skill-markdown-v1",
            portableMetadata: {
                license: claudeOptionalString(parsed, "license", candidateDiagnostics, entry.relativePath, "Skill") ?? "",
                compatibility:
                    claudeOptionalString(parsed, "compatibility", candidateDiagnostics, entry.relativePath, "Skill") ?? "",
                metadata,
            },
            invocation: {
                pathCondition:
                    pathsValid && pathPatterns.length > 0
                        ? {
                              mode: "required",
                              patterns: uniquePreservingOrder(pathPatterns),
                          }
                        : { mode: "none" },
                user:
                    claudeBooleanFrontmatter(parsed, "user-invocable", candidateDiagnostics, entry.relativePath, "Skill") ===
                    false
                        ? { mode: "not_directly_invocable" }
                        : { mode: "direct", commandName: basename(folder) },
                model:
                    claudeBooleanFrontmatter(
                        parsed,
                        "disable-model-invocation",
                        candidateDiagnostics,
                        entry.relativePath,
                        "Skill",
                    ) === true
                        ? { mode: "disabled" }
                        : { mode: "model_decision" },
                argumentHint:
                    claudeOptionalString(parsed, "argument-hint", candidateDiagnostics, entry.relativePath, "Skill") ?? "",
                argumentNames: uniquePreservingOrder(
                    claudeStringList(parsed, "arguments", candidateDiagnostics, entry.relativePath, "Skill") ?? [],
                ),
            },
            toolPolicy: {
                preapproved: filteredPreapproved,
                denied,
                otherwise: "inherit_agent_runtime_policy",
            },
            execution: isolated
                ? {
                      mode: "isolated",
                      agent:
                          rawAgent === undefined || !runtimeNativeAgent
                              ? { mode: "agent_runtime_default" }
                              : {
                                    mode: "agent_runtime_named",
                                    dialectId: "claudecode-agent-name-v1",
                                    selector: rawAgent,
                                },
                      model: selectorTier(
                          claudeOptionalString(parsed, "model", candidateDiagnostics, entry.relativePath, "Skill"),
                          CLAUDECODE_MODEL_DIALECT,
                          modelTier,
                      ),
                      effort: selectorTier(
                          claudeOptionalString(parsed, "effort", candidateDiagnostics, entry.relativePath, "Skill"),
                          CLAUDECODE_EFFORT_DIALECT,
                          effortTier,
                      ),
                  }
                : {
                      mode: "caller",
                      model: selectorTier(
                          claudeOptionalString(parsed, "model", candidateDiagnostics, entry.relativePath, "Skill"),
                          CLAUDECODE_MODEL_DIALECT,
                          modelTier,
                      ),
                      effort: selectorTier(
                          claudeOptionalString(parsed, "effort", candidateDiagnostics, entry.relativePath, "Skill"),
                          CLAUDECODE_EFFORT_DIALECT,
                          effortTier,
                      ),
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
        const complete = candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Skill", scan, folder);
        const originRecords: Array<FileRecord | DirectoryRecord> = [...sourceFiles, ...sourceDirectories];
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, folder, entry.observedReadEntryId),
            displayName: typeData.name,
            displayDescription: typeData.description,
            files: canonicalFiles,
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.skill, sourceFiles, sourceDirectories),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: canonicalGraph.sourceFileOrigins,
            sourceContainerEntryIds: sourceDirectories.map((directory) => directory.observedReadEntryId).sort(compareText),
            metadataSourceOrigins: metadataOrigins(entry.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(
                scan,
                entry,
                [
                    "claude_skill_metadata",
                    defaultName ? "name_from_directory" : "name_from_frontmatter",
                    defaultDescription ? "description_from_body" : "description_from_frontmatter",
                ].join(";"),
            ),
            diagnostics: candidateDiagnostics,
            kind: "Skill",
            typeData,
        };
        scan.attachCandidate(candidateId, originRecords);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

/** Claude's loader uses the first non-empty Markdown line, without a heading prefix. */
function descriptionFromBody(body: string): string | undefined {
    const line = body
        .split("\n")
        .map((value) => value.trim())
        .find((value) => value !== "");
    if (line === undefined) return undefined;
    const text = /^#+\s+(.+)$/u.exec(line)?.[1] ?? line;
    return text.length > 100 ? `${text.substring(0, 97)}...` : text;
}
