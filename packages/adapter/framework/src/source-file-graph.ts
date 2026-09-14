/** Canonical file-graph assembly for declaration folders already selected by a family adapter. */

import type { CandidateFileSourceOrigin, FileReferenceV2, VersionFileInput } from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core/adapter-spi";
import type { SourceFileRecord } from "./source-model";
import { compareCodeUnitText } from "./source-text";

export interface SourceFileGraphInput<File extends SourceFileRecord> {
    sourceFiles: File[];
    entry: File;
    entryText: string;
    preserveEntryExecutable: boolean;
    logicalPathFor(file: File): string;
    referencesFor(text: string, logicalPaths: ReadonlySet<string>, logicalPath: string): FileReferenceV2[];
}

export interface SourceFileGraphResult {
    files: VersionFileInput[];
    sourceFileOrigins: CandidateFileSourceOrigin[];
}

export function buildSourceFileGraph<File extends SourceFileRecord>(input: SourceFileGraphInput<File>): SourceFileGraphResult {
    const entryMatches = input.sourceFiles.filter(
        (source) =>
            source.observedReadEntryId === input.entry.observedReadEntryId && source.relativePath === input.entry.relativePath,
    );
    if (entryMatches.length !== 1) {
        throw new Error("source file graph requires exactly one stable entry record");
    }
    const entry = entryMatches[0] as File;
    const logicalPaths = new Set(input.sourceFiles.map(input.logicalPathFor));
    const rows = input.sourceFiles.map((source) => {
        const logicalPath = input.logicalPathFor(source);
        const isEntry = source === entry;
        const file: VersionFileInput =
            isEntry || source.text !== null
                ? textFile(
                      logicalPath,
                      isEntry ? input.entryText : (source.text as string),
                      isEntry ? input.preserveEntryExecutable && source.executable : source.executable,
                      isEntry ? "entry" : "resource",
                      input.referencesFor,
                      logicalPaths,
                  )
                : {
                      logicalPath,
                      role: "resource",
                      contentKind: "binary",
                      mediaType: "application/octet-stream",
                      bytes: new Uint8Array(source.bytes),
                      executable: source.executable,
                      references: [],
                  };
        return { source, file };
    });
    rows.sort((left, right) => compareCodeUnitText(left.file.logicalPath, right.file.logicalPath));
    return {
        files: rows.map((row) => row.file),
        sourceFileOrigins: rows.map((row) => ({
            logicalPath: row.file.logicalPath,
            observedReadEntryIds: [row.source.observedReadEntryId],
        })),
    };
}

function textFile(
    logicalPath: string,
    text: string,
    executable: boolean,
    role: "entry" | "resource",
    referencesFor: SourceFileGraphInput<SourceFileRecord>["referencesFor"],
    logicalPaths: ReadonlySet<string>,
): VersionFileInput {
    return {
        logicalPath,
        role,
        contentKind: "text",
        mediaType: inferCanonicalMediaType(logicalPath, "text"),
        text,
        executable,
        references: referencesFor(text, logicalPaths, logicalPath),
    };
}
