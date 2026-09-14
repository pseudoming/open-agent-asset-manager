/** Cursor project/personal Skill directory-graph candidate builder. */

import * as path from "node:path";
import { buildSourceFileGraph, projectBoundedFrontmatterDiagnostics } from "@oaam/adapter-framework";
import type { AdapterExtractedAssetCandidate, OperationDiagnostic, SkillTypeDataV2 } from "@oaam/core";
import { cursorFrontmatterBoolean, cursorFrontmatterString, parseCursorFrontmatter } from "./cursor-frontmatter";
import {
    compareText,
    cursorCandidateBase,
    cursorCandidateId,
    cursorSkillBases,
    cursorSourceEvidence,
    isWithin,
    metadataOrigins,
    nonBlank,
    parseMarkdownReferences,
    readDiagnostic,
    relativeWithin,
    separateNative,
} from "./cursor-source-read-foundation";
import {
    CURSOR_NATIVE_DIALECTS,
    type CursorCandidateBuildResult,
    type CursorFileRecord,
    type CursorScanResult,
    type CursorSourceContext,
} from "./cursor-source-read-model";

const CURSOR_SKILL_FIELDS = new Set([
    "name",
    "description",
    "disable-model-invocation",
    "alwaysApply",
    "globs",
    "environments",
    "disabled-environments",
    "metadata",
]);
const EXECUTABLE_AUTHORITY_FIELDS = new Set(["hooks", "shell", "mcp", "plugins"]);

export function buildCursorSkillCandidates(context: CursorSourceContext, scan: CursorScanResult): CursorCandidateBuildResult {
    if (!context.ownsSharedPhysicalSource) {
        for (const record of [...scan.files, ...scan.directories]) {
            if (record.relativePath !== "") {
                scan.ignoreRecord(record, "cursor_shared_source_owned_by_sibling_runtime");
            }
        }
        return { candidates: [], diagnostics: [], ignoredSource: scan.files.length > 0 || scan.directories.length > 0 };
    }
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const base of cursorSkillBases(context.layout)) {
        for (const folder of directSkillFolders(scan, base)) {
            const files = scan.files.filter((file) => isWithin(file.relativePath, folder)).sort(compareFile);
            const directories = scan.directories
                .filter((directory) => isWithin(directory.relativePath, folder))
                .sort((left, right) => compareText(left.relativePath, right.relativePath));
            const entryPath = `${folder}/SKILL.md`;
            const entry = files.find((file) => file.relativePath === entryPath);
            if (entry === undefined) {
                ignoreGraph(scan, files, directories, "cursor_skill_entry_missing");
                diagnostics.push(
                    readDiagnostic(
                        scan.unreadableRelativePaths.includes(entryPath)
                            ? "cursor.skill_entry_unreadable"
                            : "cursor.skill_entry_missing",
                        scan.unreadableRelativePaths.includes(entryPath)
                            ? "Cursor Skill entry exists but could not be read"
                            : "Cursor Skill folder requires a direct SKILL.md entry",
                        scan.unreadableRelativePaths.includes(entryPath) ? "partial" : "invalid_schema",
                        "error",
                        entryPath,
                    ),
                );
                ignoredSource = true;
                continue;
            }
            if (entry.text === null) {
                ignoreGraph(scan, files, directories, "cursor_skill_entry_not_utf8");
                diagnostics.push(
                    readDiagnostic(
                        "cursor.skill_entry_not_utf8",
                        "Cursor Skill entry must be valid UTF-8",
                        "invalid_schema",
                        "error",
                        entry.relativePath,
                    ),
                );
                ignoredSource = true;
                continue;
            }

            const parsed = parseCursorFrontmatter(entry.text);
            const executableAuthority = parsed.presentKeys.filter((key) => EXECUTABLE_AUTHORITY_FIELDS.has(key));
            if (executableAuthority.length > 0) {
                ignoreGraph(scan, files, directories, "cursor_skill_executable_declaration");
                diagnostics.push(
                    readDiagnostic(
                        "cursor.skill_executable_declaration_rejected",
                        `Cursor Skill executable authority is outside the ordinary Skill contract: ${executableAuthority.join(", ")}`,
                        "unsupported",
                        "error",
                        entry.relativePath,
                    ),
                );
                ignoredSource = true;
                continue;
            }

            const name = nonBlank(cursorFrontmatterString(parsed, "name"));
            const description = nonBlank(cursorFrontmatterString(parsed, "description"));
            if (
                !parsed.hasFrontmatter ||
                !parsed.closed ||
                name === undefined ||
                description === undefined ||
                parsed.body.trim() === ""
            ) {
                ignoreGraph(scan, files, directories, "cursor_skill_invalid");
                diagnostics.push(
                    ...frontmatterDiagnostics(parsed, entry.relativePath),
                    readDiagnostic(
                        "cursor.skill_required_content_missing",
                        "Cursor Skill requires closed frontmatter, non-empty name and description, and a non-empty body",
                        "invalid_schema",
                        "error",
                        entry.relativePath,
                    ),
                );
                ignoredSource = true;
                continue;
            }

            const candidateDiagnostics = frontmatterDiagnostics(parsed, entry.relativePath);
            const unknownFields = parsed.presentKeys.filter(
                (field) => !CURSOR_SKILL_FIELDS.has(field) && !EXECUTABLE_AUTHORITY_FIELDS.has(field),
            );
            if (unknownFields.length > 0) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "cursor.skill_private_frontmatter_preserved",
                        `Cursor-only Skill fields are preserved for same-runtime restoration but cannot be portably converted: ${unknownFields.join(", ")}`,
                        "partial",
                        "warning",
                        entry.relativePath,
                    ),
                );
            }
            for (const unreadablePath of scan.unreadableRelativePaths.filter((value) => isWithin(value, folder))) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "cursor.skill_resource_unreadable",
                        "Cursor Skill graph is incomplete because a resource could not be read",
                        "partial",
                        "error",
                        unreadablePath,
                    ),
                );
            }
            for (const unreadablePath of scan.unreadableDirectoryPaths.filter((value) => isWithin(value, folder))) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "cursor.skill_resource_directory_unreadable",
                        "Cursor Skill graph is incomplete because a resource directory could not be listed",
                        "partial",
                        "error",
                        unreadablePath,
                    ),
                );
            }

            const graph = buildSourceFileGraph({
                sourceFiles: files,
                entry,
                entryText: parsed.body,
                preserveEntryExecutable: false,
                logicalPathFor: (file) => relativeWithin(file.relativePath, folder),
                referencesFor: parseMarkdownReferences,
            });
            const disableModelInvocation = cursorFrontmatterBoolean(parsed, "disable-model-invocation");
            if (parsed.presentKeys.includes("disable-model-invocation") && disableModelInvocation === undefined) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "cursor.skill_disable_model_invocation_invalid",
                        "Cursor Skill disable-model-invocation must be a boolean",
                        "invalid_schema",
                        "error",
                        entry.relativePath,
                    ),
                );
            }
            const typeData: SkillTypeDataV2 = {
                schemaVersion: 2,
                name,
                description,
                whenToUse: description,
                entryDialectId: CURSOR_NATIVE_DIALECTS.skill,
                portableMetadata: { license: "", compatibility: "", metadata: {} },
                invocation: {
                    pathCondition: { mode: "none" },
                    user: { mode: "direct", commandName: name },
                    model: disableModelInvocation === true ? { mode: "disabled" } : { mode: "model_decision" },
                    argumentHint: "",
                    argumentNames: [],
                },
                toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
                execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
            };
            const complete = candidateDiagnostics.every((item) => item.severity !== "error");
            const candidateId = cursorCandidateId("Skill", scan, folder);
            const candidate: AdapterExtractedAssetCandidate = {
                ...cursorCandidateBase(context, scan, candidateId, folder, entry.observedReadEntryId),
                displayName: name,
                displayDescription: description,
                files: graph.files,
                nativeRepresentation: separateNative(
                    CURSOR_NATIVE_DIALECTS.skill,
                    projectRelativeNativeRecords(context, files),
                    projectRelativeNativeRecords(context, directories),
                ),
                dialectRestorationTransition: { action: "inherit" },
                status: complete ? "complete" : "incomplete",
                assetCandidateStatus: complete ? "importable" : "incomplete",
                promotionSafety: unknownFields.length === 0 ? "default_promotable" : "requires_user_confirmation",
                sourceFileOrigins: graph.sourceFileOrigins,
                sourceContainerEntryIds: directories.map((directory) => directory.observedReadEntryId).sort(compareText),
                metadataSourceOrigins: metadataOrigins(entry.observedReadEntryId, true),
                sourceEvidence: cursorSourceEvidence(scan, entry, "cursor_skill_directory"),
                diagnostics: candidateDiagnostics,
                kind: "Skill",
                typeData,
            };
            scan.attachCandidate(candidateId, [...files, ...directories]);
            candidates.push(candidate);
        }
    }
    return { candidates, diagnostics, ignoredSource };
}

function projectRelativeNativeRecords<Record extends { relativePath: string }>(
    context: CursorSourceContext,
    records: Record[],
): Record[] {
    if (context.scope !== "project" || context.layout !== "skill_root" || context.projectRootPath === "") return records;
    const relativeRoot = path.relative(context.projectRootPath, context.root.path).split(path.sep).join("/");
    if (relativeRoot !== ".cursor/skills" && relativeRoot !== ".agents/skills") return records;
    return records.map((record) => ({ ...record, relativePath: `${relativeRoot}/${record.relativePath}` }));
}

function directSkillFolders(scan: CursorScanResult, base: string): string[] {
    const folders = scan.directories.flatMap((directory) => {
        if (base !== "" && !isWithin(directory.relativePath, base)) return [];
        const relative = base === "" ? directory.relativePath : relativeWithin(directory.relativePath, base);
        if (relative === "" || relative.includes("/") || relative === ".system") return [];
        return [directory.relativePath];
    });
    return [...new Set(folders)].sort(compareText);
}

function frontmatterDiagnostics(parsed: ReturnType<typeof parseCursorFrontmatter>, relativePath: string): OperationDiagnostic[] {
    return projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "cursor.skill_frontmatter_unclosed",
                "Cursor Skill frontmatter is not closed",
                "invalid_schema",
                "error",
                relativePath,
            ),
        (message) => readDiagnostic("cursor.skill_frontmatter_invalid", message, "invalid_schema", "error", relativePath),
    );
}

function ignoreGraph(
    scan: CursorScanResult,
    files: CursorFileRecord[],
    directories: CursorScanResult["directories"],
    reasonCode: string,
): void {
    for (const record of [...files, ...directories]) scan.ignoreRecord(record, reasonCode);
}

function compareFile(left: CursorFileRecord, right: CursorFileRecord): number {
    return compareText(left.relativePath, right.relativePath);
}
