/** ZCode Skill directory-graph candidate builder. */

import * as path from "node:path";
import type { AdapterExtractedAssetCandidate, OperationDiagnostic, SkillTypeDataV2 } from "@oaam/core";
import { buildSourceFileGraph, projectBoundedFrontmatterDiagnostics } from "@oaam/adapter-framework";
import { frontmatterString, frontmatterStringMap, parseZcodeFrontmatter } from "./zcode-frontmatter";
import {
    candidateBase,
    candidateIdFor,
    compareText,
    isWithin,
    metadataOrigins,
    nonBlank,
    parseMarkdownReferences,
    readDiagnostic,
    relativeWithin,
    separateNative,
    skillBasesForLayout,
    sourceEvidence,
} from "./zcode-source-read-foundation";
import {
    ZCODE_NATIVE_DIALECTS,
    type ZcodeFileRecord,
    type ZcodeScanResult,
    type ZcodeSourceContext,
} from "./zcode-source-read-model";

const PORTABLE_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata"]);
const EXECUTABLE_AUTHORITY_FIELDS = new Set(["hooks", "shell", "mcp", "plugins"]);

export function buildSkillCandidates(context: ZcodeSourceContext, scan: ZcodeScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const selectedBase of skillBasesForLayout(context.layout)) {
        const folders = directSkillFolders(scan, selectedBase);
        for (const folder of folders) {
            const sourceFiles = scan.files
                .filter((file) => isWithin(file.relativePath, folder))
                .sort((left, right) => compareText(left.relativePath, right.relativePath));
            const sourceDirectories = scan.directories
                .filter((directory) => isWithin(directory.relativePath, folder))
                .sort((left, right) => compareText(left.relativePath, right.relativePath));
            const entryPath = `${folder}/SKILL.md`;
            const entry = sourceFiles.find((file) => file.relativePath === entryPath);
            if (entry === undefined) {
                ignoreSkillGraph(scan, sourceFiles, sourceDirectories, "skill_entry_missing");
                diagnostics.push(
                    readDiagnostic(
                        scan.unreadableRelativePaths.includes(entryPath)
                            ? "zcode.skill_entry_unreadable"
                            : "zcode.skill_entry_missing",
                        scan.unreadableRelativePaths.includes(entryPath)
                            ? "ZCode Skill entry exists but could not be read"
                            : "ZCode Skill folder requires a direct SKILL.md entry",
                        scan.unreadableRelativePaths.includes(entryPath) ? "partial" : "invalid_schema",
                        "error",
                        entryPath,
                    ),
                );
                ignoredSource = true;
                continue;
            }
            if (entry.text === null) {
                ignoreSkillGraph(scan, sourceFiles, sourceDirectories, "skill_entry_not_utf8");
                diagnostics.push(
                    readDiagnostic(
                        "zcode.skill_entry_not_utf8",
                        "ZCode Skill entry must be valid UTF-8",
                        "invalid_schema",
                        "error",
                        entry.relativePath,
                    ),
                );
                ignoredSource = true;
                continue;
            }

            const parsed = parseZcodeFrontmatter(entry.text);
            const executableAuthority = parsed.presentKeys.filter((key) => EXECUTABLE_AUTHORITY_FIELDS.has(key));
            if (executableAuthority.length > 0) {
                ignoreSkillGraph(scan, sourceFiles, sourceDirectories, "executable_skill_source");
                diagnostics.push(
                    readDiagnostic(
                        "zcode.skill_executable_declaration_rejected",
                        `ZCode Skill executable authority is outside the ordinary Skill contract: ${executableAuthority.join(", ")}`,
                        "unsupported",
                        "error",
                        entry.relativePath,
                    ),
                );
                ignoredSource = true;
                continue;
            }

            const name = nonBlank(frontmatterString(parsed, "name"));
            const description = nonBlank(frontmatterString(parsed, "description"));
            if (
                !parsed.hasFrontmatter ||
                !parsed.closed ||
                name === undefined ||
                description === undefined ||
                parsed.body.trim() === ""
            ) {
                ignoreSkillGraph(scan, sourceFiles, sourceDirectories, "invalid_skill_source");
                diagnostics.push(
                    ...frontmatterDiagnostics(parsed, entry.relativePath),
                    readDiagnostic(
                        "zcode.skill_required_content_missing",
                        "ZCode Skill requires closed frontmatter, non-empty name and description, and a non-empty body",
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
                (field) => !PORTABLE_FIELDS.has(field) && !EXECUTABLE_AUTHORITY_FIELDS.has(field),
            );
            if (unknownFields.length > 0) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "zcode.skill_frontmatter_semantics_unsupported",
                        `ZCode Skill frontmatter fields cannot be represented: ${unknownFields.join(", ")}`,
                        "unsupported",
                        "error",
                        entry.relativePath,
                    ),
                );
            }
            const metadata = frontmatterStringMap(parsed, "metadata");
            if (parsed.presentKeys.includes("metadata") && metadata === undefined) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "zcode.skill_metadata_invalid",
                        "ZCode Skill metadata must be a string-to-string mapping",
                        "invalid_schema",
                        "error",
                        entry.relativePath,
                    ),
                );
            }
            for (const unreadablePath of scan.unreadableRelativePaths.filter((path) => isWithin(path, folder))) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "zcode.skill_resource_unreadable",
                        "ZCode Skill graph is incomplete because a resource could not be read",
                        "partial",
                        "error",
                        unreadablePath,
                    ),
                );
            }
            for (const unreadablePath of scan.unreadableDirectoryPaths.filter((path) => isWithin(path, folder))) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "zcode.skill_resource_directory_unreadable",
                        "ZCode Skill graph is incomplete because a resource directory could not be listed",
                        "partial",
                        "error",
                        unreadablePath,
                    ),
                );
            }

            const canonicalGraph = buildSourceFileGraph({
                sourceFiles,
                entry,
                entryText: parsed.body,
                preserveEntryExecutable: false,
                logicalPathFor: (file) => relativeWithin(file.relativePath, folder),
                referencesFor: parseMarkdownReferences,
            });
            const typeData: SkillTypeDataV2 = {
                schemaVersion: 2,
                name,
                description,
                whenToUse: description,
                entryDialectId: "zcode-skill-markdown-v1",
                portableMetadata: {
                    license: frontmatterString(parsed, "license") ?? "",
                    compatibility: frontmatterString(parsed, "compatibility") ?? "",
                    metadata: metadata ?? {},
                },
                invocation: {
                    pathCondition: { mode: "none" },
                    user: { mode: "direct", commandName: name },
                    model: { mode: "model_decision" },
                    argumentHint: "",
                    argumentNames: [],
                },
                toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
                execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
            };
            const complete = candidateDiagnostics.every((item) => item.severity !== "error");
            const candidateId = candidateIdFor("Skill", scan, folder);
            const candidate: AdapterExtractedAssetCandidate = {
                ...candidateBase(context, scan, candidateId, entry, folder),
                scopePath: "",
                displayName: name,
                displayDescription: description,
                files: canonicalGraph.files,
                nativeRepresentation: separateNative(
                    ZCODE_NATIVE_DIALECTS.skill,
                    projectRelativeNativeSkillFiles(context, sourceFiles),
                    projectRelativeNativeSkillDirectories(context, sourceDirectories),
                ),
                dialectRestorationTransition: { action: "inherit" },
                status: complete ? "complete" : "incomplete",
                assetCandidateStatus: complete ? "importable" : "incomplete",
                promotionSafety: "default_promotable",
                sourceFileOrigins: canonicalGraph.sourceFileOrigins,
                sourceContainerEntryIds: sourceDirectories.map((directory) => directory.observedReadEntryId).sort(compareText),
                metadataSourceOrigins: metadataOrigins(entry.observedReadEntryId, true),
                sourceEvidence: sourceEvidence(scan, entry, "zcode_skill_directory"),
                diagnostics: candidateDiagnostics,
                kind: "Skill",
                typeData,
            };
            scan.attachCandidate(candidateId, [...sourceFiles, ...sourceDirectories]);
            candidates.push(candidate);
        }
    }
    return { candidates, diagnostics, ignoredSource };
}

function projectRelativeNativeSkillDirectories(
    context: ZcodeSourceContext,
    directories: ZcodeScanResult["directories"],
): ZcodeScanResult["directories"] {
    if (context.scope !== "project" || context.layout !== "skill_root" || context.projectRootPath === "") return directories;
    const relativeRoot = path.relative(context.projectRootPath, context.root.path).split(path.sep).join("/");
    if (relativeRoot !== ".zcode/skills" && relativeRoot !== ".agents/skills") return directories;
    return directories.map((directory) => ({ ...directory, relativePath: `${relativeRoot}/${directory.relativePath}` }));
}

function projectRelativeNativeSkillFiles(context: ZcodeSourceContext, files: ZcodeFileRecord[]): ZcodeFileRecord[] {
    if (context.scope !== "project" || context.layout !== "skill_root" || context.projectRootPath === "") return files;
    const relativeRoot = path.relative(context.projectRootPath, context.root.path).split(path.sep).join("/");
    if (relativeRoot !== ".zcode/skills" && relativeRoot !== ".agents/skills") return files;
    return files.map((file) => ({ ...file, relativePath: `${relativeRoot}/${file.relativePath}` }));
}

function directSkillFolders(scan: ZcodeScanResult, base: string): string[] {
    const folders = scan.directories.flatMap((directory) => {
        if (base !== "" && !isWithin(directory.relativePath, base)) return [];
        const relative = base === "" ? directory.relativePath : relativeWithin(directory.relativePath, base);
        if (relative === "" || relative.includes("/") || relative === ".system") return [];
        return [directory.relativePath];
    });
    return [...new Set(folders)].sort(compareText);
}

function frontmatterDiagnostics(parsed: ReturnType<typeof parseZcodeFrontmatter>, path: string): OperationDiagnostic[] {
    return projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "zcode.skill_frontmatter_unclosed",
                "ZCode Skill frontmatter is not closed",
                "invalid_schema",
                "error",
                path,
            ),
        (message) => readDiagnostic("zcode.skill_frontmatter_invalid", message, "invalid_schema", "error", path),
    );
}

function ignoreSkillGraph(
    scan: ZcodeScanResult,
    files: ZcodeFileRecord[],
    directories: ZcodeScanResult["directories"],
    reasonCode: string,
): void {
    for (const record of [...files, ...directories]) scan.ignoreRecord(record, reasonCode);
}
