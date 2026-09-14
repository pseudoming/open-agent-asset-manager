import type { AdapterReadResult, ImportPreviewSnapshotV1 } from "@oaam/core";
import { joinPhysicalAccessPath, splitPhysicalAccessPath } from "@oaam/shared/paths";

type ImportCandidate = AdapterReadResult["candidates"][number];
type ImportCandidateFile = ImportCandidate["files"][number];

export function requireImportPreviewCandidate(
    snapshot: ImportPreviewSnapshotV1,
    candidateId: string,
    unavailable: Error,
): ImportCandidate {
    const candidates = snapshot.readResults.flatMap((result) =>
        result.candidates.filter((candidate) => candidate.candidateId === candidateId),
    );
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate === undefined) throw unavailable;
    return candidate;
}

export function requireImportPreviewCandidateFile(
    candidate: ImportCandidate,
    logicalPath: string | undefined,
    unavailable: Error,
): ImportCandidateFile {
    const files = [...candidate.files].sort((left, right) => (left.logicalPath < right.logicalPath ? -1 : 1));
    const file = logicalPath === undefined ? files[0] : files.find((entry) => entry.logicalPath === logicalPath);
    if (file === undefined) throw unavailable;
    return file;
}

export function resolveImportPreviewFileDirectoryFromSnapshot(
    snapshot: ImportPreviewSnapshotV1,
    candidate: ImportCandidate,
    file: ImportCandidateFile,
    unavailable: Error,
): string {
    const origins = candidate.sourceFileOrigins.filter((origin) => origin.logicalPath === file.logicalPath);
    const origin = origins[0];
    if (origins.length !== 1 || origin === undefined || origin.observedReadEntryIds.length !== 1) throw unavailable;
    const observedReadEntryId = origin.observedReadEntryIds[0] as string;
    const authorities = snapshot.readResults.flatMap((result) => {
        const entries = result.observedReadEntries.filter(
            (entry) => entry.observedReadEntryId === observedReadEntryId && entry.entryKind === "file",
        );
        return entries.flatMap((entry) =>
            result.sourceRoots
                .filter((root) => root.sourceRootId === entry.sourceRootId && root.accessStatus === "available")
                .map((root) => ({ entry, root })),
        );
    });
    const authority = authorities[0];
    if (authorities.length !== 1 || authority === undefined) throw unavailable;
    return splitPhysicalAccessPath(joinPhysicalAccessPath(authority.root.path, authority.entry.relativePath)).parentPath;
}
