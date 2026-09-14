/** Claude Code project-keyed Memory catalog and topic candidate builder. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic } from "@oaam/core";
import { frontmatterString, frontmatterStringMap, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import {
    basename,
    candidateBase,
    candidateIdFor,
    frontmatterDiagnostics,
    metadataOrigins,
    nonBlank,
    parseMemoryIndex,
    readDiagnostic,
    rejectNonUtf8Declaration,
    separateNative,
    sourceEvidence,
    textEntry,
    withoutExtension,
} from "./claudecode-source-read-foundation";
import {
    CLAUDECODE_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type DirectoryRecord,
    type FileRecord,
    type ScanResult,
    type SourceContext,
} from "./claudecode-source-read-model";

export function buildMemoryCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const index = scan.files.find((file) => file.relativePath === "MEMORY.md");
    if (index?.text === null) {
        rejectNonUtf8Declaration(scan, index, "Memory catalog", diagnostics);
        ignoredSource = true;
    }
    const parsedIndex =
        index?.text === null || index?.text === undefined
            ? { links: new Map<string, { title: string; hint: string }>(), members: [], issues: [] }
            : parseMemoryIndex(index.text);
    const indexLinks = parsedIndex.links;
    const rootDirectory = scan.directories.find((directory) => directory.relativePath === "");

    if (index !== undefined && index.text !== null) {
        const candidateId = candidateIdFor("Memory", scan, "MEMORY.md#catalog");
        const records: Array<FileRecord | DirectoryRecord> = [index];
        if (rootDirectory !== undefined) records.push(rootDirectory);
        const catalogDiagnostics = parsedIndex.issues.map((issue) =>
            readDiagnostic(
                issue.code === "duplicate_member"
                    ? "claudecode.memory_catalog_member_duplicate"
                    : "claudecode.memory_catalog_member_invalid",
                issue.code === "duplicate_member"
                    ? `Memory catalog repeats one canonical member path at line ${issue.lineNumber}`
                    : `Memory catalog contains an invalid member declaration at line ${issue.lineNumber}`,
                "invalid_schema",
                "error",
                index.relativePath,
            ),
        );
        const complete = catalogDiagnostics.length === 0;
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, "MEMORY.md", index.observedReadEntryId),
            displayName: "Claude Code Memory catalog",
            displayDescription: "Ordered Claude Code Memory topics",
            files: [],
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.memoryCatalog, [
                { ...index, relativePath: "MEMORY.md" },
            ]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [],
            sourceContainerEntryIds: rootDirectory === undefined ? [] : [rootDirectory.observedReadEntryId],
            metadataSourceOrigins: metadataOrigins(index.observedReadEntryId, false),
            sourceEvidence: sourceEvidence(scan, index, "memory_catalog"),
            diagnostics: catalogDiagnostics,
            kind: "Memory",
            typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
            ...(complete ? { memoryCatalogMemberBindingInputs: parsedIndex.members } : {}),
        };
        scan.attachCandidate(candidateId, records);
        candidates.push(candidate);
    }

    for (const file of scan.files) {
        if (basename(file.relativePath) === "MEMORY.md") {
            if (file.relativePath !== "MEMORY.md") {
                scan.ignoreRecord(file, "nested_memory_catalog");
                ignoredSource = true;
            }
            continue;
        }
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Memory topic", diagnostics);
            ignoredSource = true;
            continue;
        }
        if (file.text.trim() === "") continue;
        const parsed = parseClaudeFrontmatter(file.text);
        const candidateDiagnostics = frontmatterDiagnostics(parsed, file.relativePath);
        const topLevelType = nonBlank(frontmatterString(parsed, "type"));
        const metadata = frontmatterStringMap(parsed, "metadata") ?? {};
        const nestedType = nonBlank(metadata.type);
        const typeConflict = topLevelType !== undefined && nestedType !== undefined && topLevelType !== nestedType;
        const selectedType = topLevelType ?? nestedType;
        if (typeConflict) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.memory_type_conflict",
                    "Memory top-level type conflicts with metadata.type",
                    "conflict",
                    "error",
                    file.relativePath,
                ),
            );
        }
        if (selectedType === undefined || !["user", "feedback", "project", "reference"].includes(selectedType)) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.memory_type_missing_or_unknown",
                    "Memory requires a recognized Claude classification",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const name = nonBlank(frontmatterString(parsed, "name")) ?? withoutExtension(basename(file.relativePath));
        const description = frontmatterString(parsed, "description") ?? "";
        if (!parsed.hasFrontmatter || description.trim() === "") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.memory_metadata_incomplete",
                    "Memory topic lacks complete frontmatter/description",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        const link = indexLinks.get(file.relativePath);
        if (index !== undefined && link === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.memory_topic_unlinked",
                    "Memory topic is not linked from MEMORY.md but remains a source candidate",
                    "partial",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const dialectPayload = {
            schemaVersion: 1,
            dialectId: CLAUDECODE_NATIVE_DIALECTS.memoryTopic,
            topLevelType: topLevelType ?? "",
            metadataType: nestedType ?? "",
            metadataOriginSessionId: metadata.originSessionId ?? "",
            metadataNodeType: metadata.node_type ?? "",
        };
        const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Memory", scan, file.relativePath);
        const originRecords: Array<FileRecord | DirectoryRecord> = [file];
        if (index !== undefined && link !== undefined) originRecords.push(index);
        const sourceEvidenceRows = sourceEvidence(scan, file, "memory_topic");
        if (index !== undefined && link !== undefined) {
            sourceEvidenceRows.push({
                evidenceOrigin: "observed_read",
                observedReadEntryId: index.observedReadEntryId,
                kind: "summary",
                value: `MEMORY.md:${link.title}:${link.hint}`,
                evidenceLevel: "agent_runtime_verified",
            });
        }
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: [textEntry("memory.md", body)],
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.memoryTopic, [
                { ...file, relativePath: file.relativePath },
            ]),
            dialectRestorationTransition: {
                action: "replace",
                bytes: Buffer.from(JSON.stringify(dialectPayload), "utf-8"),
            },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "requires_user_confirmation",
            sourceFileOrigins: [
                {
                    logicalPath: "memory.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidenceRows,
            diagnostics: candidateDiagnostics,
            kind: "Memory",
            typeData: {
                schemaVersion: 2,
                entityRole: "unit",
                card: { name, description },
                loading: { card: "high", body: "low" },
                applicabilityRule: "",
            },
        };
        scan.attachCandidate(candidateId, originRecords);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
