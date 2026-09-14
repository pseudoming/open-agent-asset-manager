/** Codex Skill directory-graph candidate builder. */

import type {
    AdapterExtractedAssetCandidate,
    CandidateMetadataSourceOrigin,
    OperationDiagnostic,
    SkillTypeDataV2,
} from "@oaam/core";
import { buildSourceFileGraph } from "@oaam/adapter-framework";
import { frontmatterString, frontmatterStringMap, parseCodexFrontmatter } from "./codex-frontmatter";
import { parseCodexSkillMetadata } from "./codex-skill-metadata";
import {
    candidateBase,
    candidateIdFor,
    codexSkillFolderForEntry,
    compareText,
    isWithin,
    metadataOrigins,
    nonBlank,
    parseMarkdownReferences,
    readDiagnostic,
    relativeWithin,
    separateNative,
    sourceEvidence,
} from "./codex-source-read-foundation";
import {
    CODEX_NATIVE_DIALECTS,
    type CodexFileRecord,
    type CodexScanResult,
    type CodexSourceContext,
} from "./codex-source-read-model";

const SKILL_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata"]);

export function buildSkillCandidates(context: CodexSourceContext, scan: CodexScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const layout = context.layout;
    if (layout !== "project" && layout !== "skill_root") return { candidates, diagnostics, ignoredSource };

    for (const relativePath of scan.unreadableRelativePaths) {
        if (codexSkillFolderForEntry(relativePath, layout) === null) continue;
        diagnostics.push(
            readDiagnostic(
                "codex.skill_entry_unreadable",
                "Codex Skill entry exists but could not be read",
                "partial",
                "error",
                relativePath,
            ),
        );
        ignoredSource = true;
    }

    const entries = scan.files
        .filter((file) => codexSkillFolderForEntry(file.relativePath, layout) !== null)
        .sort((left, right) => compareText(left.relativePath, right.relativePath));
    for (const entry of entries) {
        const folder = codexSkillFolderForEntry(entry.relativePath, layout);
        if (folder === null) continue;
        const sourceFiles = scan.files
            .filter((file) => isWithin(file.relativePath, folder))
            .sort((left, right) => compareText(left.relativePath, right.relativePath));
        const sourceDirectories = scan.directories
            .filter((directory) => isWithin(directory.relativePath, folder))
            .sort((left, right) => compareText(left.relativePath, right.relativePath));
        if (entry.text === null) {
            ignoreSkillGraph(scan, sourceFiles, sourceDirectories, "skill_entry_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "codex.skill_entry_not_utf8",
                    "Codex Skill entry must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }

        const parsed = parseCodexFrontmatter(entry.text);
        if (parsed.presentKeys.includes("hooks") || parsed.presentKeys.includes("shell")) {
            ignoreSkillGraph(scan, sourceFiles, sourceDirectories, "executable_skill_source");
            diagnostics.push(
                readDiagnostic(
                    "codex.skill_executable_declaration_rejected",
                    "Skill hooks or shell declarations are outside the OAAM v1 Skill authority",
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
                ...frontmatterDiagnostics(parsed.diagnostics, entry.relativePath),
                readDiagnostic(
                    "codex.skill_required_content_missing",
                    "Codex Skill requires closed frontmatter, non-empty name and description, and a non-empty body",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }

        const candidateDiagnostics = frontmatterDiagnostics(parsed.diagnostics, entry.relativePath);
        const unknownFields = parsed.presentKeys.filter((field) => !SKILL_FIELDS.has(field));
        if (unknownFields.length > 0) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "codex.skill_frontmatter_semantics_unsupported",
                    `Codex Skill frontmatter fields cannot be represented: ${unknownFields.join(", ")}`,
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
                    "codex.skill_metadata_invalid",
                    "Codex Skill metadata must be a string-to-string mapping",
                    "invalid_schema",
                    "error",
                    entry.relativePath,
                ),
            );
        }

        const metadataFile = sourceFiles.find((file) => relativeWithin(file.relativePath, folder) === "agents/openai.yaml");
        const metadataResult = parseOptionalMetadata(metadataFile, candidateDiagnostics);
        for (const unreadablePath of scan.unreadableRelativePaths.filter((path) => isWithin(path, folder))) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "codex.skill_resource_unreadable",
                    "Codex Skill graph is incomplete because a resource could not be read",
                    "partial",
                    "error",
                    unreadablePath,
                ),
            );
        }

        const typeData: SkillTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            whenToUse: "",
            entryDialectId: "codex-skill-markdown-v1",
            portableMetadata: {
                license: frontmatterString(parsed, "license") ?? "",
                compatibility: frontmatterString(parsed, "compatibility") ?? "",
                metadata: metadata ?? {},
            },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: name },
                model: metadataResult.allowImplicitInvocation ? { mode: "model_decision" } : { mode: "disabled" },
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
        const complete = candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Skill", scan, folder);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, folder, entry.observedReadEntryId),
            scopePath: "",
            displayName: name,
            displayDescription: description,
            files: canonicalGraph.files,
            nativeRepresentation: separateNative(CODEX_NATIVE_DIALECTS.skill, sourceFiles, sourceDirectories),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: canonicalGraph.sourceFileOrigins,
            sourceContainerEntryIds: sourceDirectories.map((directory) => directory.observedReadEntryId).sort(compareText),
            metadataSourceOrigins: metadataSourceOrigins(entry, metadataFile),
            sourceEvidence: sourceEvidence(scan, entry, "codex_skill_directory"),
            diagnostics: candidateDiagnostics,
            kind: "Skill",
            typeData,
        };
        scan.attachCandidate(candidateId, [...sourceFiles, ...sourceDirectories]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function parseOptionalMetadata(file: CodexFileRecord | undefined, diagnostics: OperationDiagnostic[]) {
    if (file === undefined) return { allowImplicitInvocation: true };
    if (file.text === null) {
        diagnostics.push(
            readDiagnostic(
                "codex.skill_openai_yaml_not_utf8",
                "Codex agents/openai.yaml must be valid UTF-8",
                "invalid_schema",
                "error",
                file.relativePath,
            ),
        );
        return { allowImplicitInvocation: true };
    }
    const parsed = parseCodexSkillMetadata(file.text);
    for (const message of parsed.diagnostics) {
        diagnostics.push(
            readDiagnostic("codex.skill_openai_yaml_invalid", message, "invalid_schema", "error", file.relativePath),
        );
    }
    for (const message of parsed.nativeOnlyDiagnostics) {
        diagnostics.push(
            readDiagnostic("codex.skill_openai_yaml_native_only", message, "unsupported", "warning", file.relativePath),
        );
    }
    return { allowImplicitInvocation: parsed.allowImplicitInvocation };
}

function frontmatterDiagnostics(messages: string[], path: string): OperationDiagnostic[] {
    return messages.map((message) =>
        readDiagnostic(
            message.includes("metadata.") ? "codex.skill_metadata_invalid" : "codex.skill_frontmatter_invalid",
            message,
            "invalid_schema",
            "error",
            path,
        ),
    );
}

function metadataSourceOrigins(entry: CodexFileRecord, metadataFile: CodexFileRecord | undefined) {
    const origins: CandidateMetadataSourceOrigin[] = metadataOrigins(entry.observedReadEntryId, true);
    if (metadataFile !== undefined) {
        origins.push({ metadataSubject: "type_data", observedReadEntryId: metadataFile.observedReadEntryId });
    }
    return origins.sort((left, right) =>
        compareText(
            `${left.metadataSubject}\0${left.observedReadEntryId}`,
            `${right.metadataSubject}\0${right.observedReadEntryId}`,
        ),
    );
}

function ignoreSkillGraph(
    scan: CodexScanResult,
    files: CodexFileRecord[],
    directories: CodexScanResult["directories"],
    reasonCode: string,
): void {
    for (const record of [...files, ...directories]) scan.ignoreRecord(record, reasonCode);
}
