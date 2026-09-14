/** Runtime-neutral source-read records; family semantics stay in adapter extensions. */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AssetScope,
    OperationDiagnostic,
    PosixRelativePath,
    ProviderReadEntryDisposition,
    ReadAccessOutcomeStatus,
    ReadEntryHandle,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";

type NoExtension = Record<never, never>;

export type SourceContextBase<Layout extends string, Extension extends object = NoExtension> = {
    root: SourceRoot;
    scope: AssetScope;
    projectRootPath: string;
    layout: Layout;
} & Extension;

export type SourceFileRecord<Extension extends object = NoExtension> = {
    handle: ReadEntryHandle;
    observedReadEntryId: string;
    relativePath: string;
    bytes: Uint8Array;
    executable: boolean;
    text: string | null;
} & Extension;

export type SourceDirectoryRecord<Extension extends object = NoExtension> = {
    handle: ReadEntryHandle;
    observedReadEntryId: string;
    relativePath: string;
} & Extension;

export type SourceRecord<
    File extends SourceFileRecord = SourceFileRecord,
    Directory extends SourceDirectoryRecord = SourceDirectoryRecord,
> = File | Directory;

export type ReferencedSourceFileReadResult<File extends SourceFileRecord = SourceFileRecord> =
    | { state: "succeeded"; file: File }
    | {
          state: "failed";
          failureStatus: Exclude<ReadAccessOutcomeStatus, "succeeded"> | "not_file";
          handle?: ReadEntryHandle;
      };

/**
 * Deterministic fail-closed resolver for synthetic native-reopen scans, which
 * may only consume the already persisted graph and cannot discover new files.
 */
export async function unavailableReferencedSourceFileRead(
    _relativePath: PosixRelativePath,
): Promise<ReferencedSourceFileReadResult> {
    return { state: "failed", failureStatus: "not_found" };
}

export type SourceScanResultBase<
    File extends SourceFileRecord = SourceFileRecord,
    Directory extends SourceDirectoryRecord = SourceDirectoryRecord,
    Extension extends object = NoExtension,
> = {
    obligation: SourceReadObligation;
    capability: AdapterAssetSourceCapability;
    files: File[];
    directories: Directory[];
    dispositions: ProviderReadEntryDisposition[];
    observedReadEntryIds: string[];
    diagnostics: OperationDiagnostic[];
    hadIgnoredSource: boolean;
    attachCandidate(candidateId: string, records: Array<File | Directory>): void;
    ignoreRecord(record: File | Directory, reasonCode: string): void;
    ignoreHandle(handle: ReadEntryHandle, reasonCode: string): void;
    /** Resolve and read one manifest-referenced file through the same bounded Core-port authority. */
    readReferencedFile(relativePath: PosixRelativePath): Promise<ReferencedSourceFileReadResult<File>>;
} & Extension;

export interface SourceCandidateBuildResult {
    candidates: AdapterExtractedAssetCandidate[];
    diagnostics: OperationDiagnostic[];
    ignoredSource: boolean;
}

export type SourceCandidateBuilder<Context, Scan> = (context: Context, scan: Scan) => SourceCandidateBuildResult;
