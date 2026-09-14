/** Codex Guidance hierarchy, precedence, and canonical candidate mapping. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic } from "@oaam/core";
import {
    basename,
    candidateBase,
    candidateIdFor,
    compareText,
    metadataOrigins,
    parentPath,
    readDiagnostic,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./codex-source-read-foundation";
import {
    CODEX_NATIVE_DIALECTS,
    type CodexFileRecord,
    type CodexScanResult,
    type CodexSourceContext,
} from "./codex-source-read-model";

const STANDARD_GUIDANCE_FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

export function buildGuidanceCandidates(context: CodexSourceContext, scan: CodexScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const filenames = [...STANDARD_GUIDANCE_FILENAMES, ...context.fallbackFilenames];
    const directories = guidanceDirectories(scan);

    if (!context.fallbackConfigurationKnown && context.layout === "project") {
        diagnostics.push(
            readDiagnostic(
                "codex.guidance_fallback_configuration_unknown",
                "Codex project Guidance fallback filenames are not bound by the current read contract; only AGENTS.override.md and AGENTS.md were scanned",
                "partial",
                "warning",
                context.root.path,
            ),
        );
        ignoredSource = true;
    }

    for (const directory of directories) {
        const result = selectGuidanceInDirectory(scan, directory, filenames, diagnostics);
        ignoredSource ||= result.ignoredSource;
        const file = result.file;
        if (file === null) continue;
        const candidateId = candidateIdFor("Guidance", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: basename(file.relativePath),
            displayDescription: directory === "" ? "Codex Guidance" : `Codex Guidance for ${directory}`,
            files: [{ ...textEntry("GUIDANCE.md", file.text as string), references: [] }],
            nativeRepresentation: separateNative(CODEX_NATIVE_DIALECTS.guidance, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety:
                basename(file.relativePath) === "AGENTS.override.md" ? "requires_user_confirmation" : "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "GUIDANCE.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, false),
            sourceEvidence: sourceEvidence(scan, file, "codex_guidance"),
            diagnostics: [],
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function guidanceDirectories(scan: CodexScanResult): string[] {
    return [
        ...new Set([...scan.files.map((file) => parentPath(file.relativePath)), ...scan.unreadableRelativePaths.map(parentPath)]),
    ].sort(compareText);
}

function selectGuidanceInDirectory(
    scan: CodexScanResult,
    directory: string,
    filenames: readonly string[],
    diagnostics: OperationDiagnostic[],
): { file: CodexFileRecord | null; ignoredSource: boolean } {
    const byName = new Map(
        scan.files
            .filter((file) => parentPath(file.relativePath) === directory)
            .map((file) => [basename(file.relativePath), file]),
    );
    const unreadable = new Set(
        scan.unreadableRelativePaths
            .filter((relativePath) => parentPath(relativePath) === directory)
            .map((relativePath) => basename(relativePath)),
    );
    let selected: CodexFileRecord | null = null;
    let ignoredSource = false;
    for (const filename of filenames) {
        if (unreadable.has(filename)) {
            diagnostics.push(
                readDiagnostic(
                    "codex.guidance_preferred_source_unreadable",
                    "A preferred Codex Guidance source exists but could not be read; lower-priority fallback is blocked",
                    "partial",
                    "error",
                    joinPortable(directory, filename),
                ),
            );
            ignoredSource = true;
            break;
        }
        const file = byName.get(filename);
        if (file === undefined) continue;
        if (file.executable) {
            scan.ignoreRecord(file, "executable_guidance_rejected");
            diagnostics.push(
                readDiagnostic(
                    "codex.guidance_executable_rejected",
                    "Executable Codex Guidance is rejected and blocks lower-priority fallback",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            break;
        }
        if (file.text === null) {
            scan.ignoreRecord(file, "guidance_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "codex.guidance_not_utf8",
                    "Codex Guidance is not valid UTF-8 and blocks lower-priority fallback",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            break;
        }
        if (file.text.trim() === "") {
            scan.ignoreRecord(file, "empty_guidance");
            ignoredSource = true;
            continue;
        }
        selected = file;
        break;
    }
    for (const file of byName.values()) {
        if (file === selected) continue;
        scan.ignoreRecord(file, selected === null ? "unselected_guidance_source" : "shadowed_guidance_source");
        ignoredSource = true;
    }
    return { file: selected, ignoredSource };
}

function joinPortable(parent: string, name: string): string {
    return parent === "" ? name : `${parent}/${name}`;
}
