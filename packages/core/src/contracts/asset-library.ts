import type { AssetVersionFileV2 } from "./asset-version";
import type { AssetKind, AssetScope, EpochMillis, PosixRelativePath, Sha256Digest, UuidV4, VersionStatus } from "./primitives";

export interface CurrentAssetSummary {
    assetId: UuidV4;
    kind: AssetKind;
    scope: AssetScope;
    projectId: string;
    scopePath: string;
    displayName: string;
    displayDescription: string;
    currentVersionId: UuidV4;
    currentRevision: number;
    currentFingerprint: Sha256Digest;
    currentVersionStatus: VersionStatus;
    assetCreatedAt: EpochMillis;
    assetUpdatedAt: EpochMillis;
    deleted: boolean;
}

export interface AssetListFilter {
    kind?: AssetKind;
    scope?: AssetScope;
    projectId?: string;
    scopePathPrefix?: string;
    includeDeleted?: boolean;
    currentVersionStatus?: VersionStatus;
}

export type AssetLibrarySubject = { scope: "global" } | { scope: "project"; projectId: UuidV4 };

export interface AssetLibraryFilter {
    subject: AssetLibrarySubject;
    keywords: string;
    includeDeleted?: boolean;
}

export interface AssetKindCount {
    kind: AssetKind;
    count: number;
}

export interface QueryAssetKindCountsInput extends AssetLibraryFilter {}

export interface QueryAssetSummaryPageInput extends AssetLibraryFilter {
    kind: AssetKind;
    pageSize?: number;
    cursor?: string;
}

export type AssetSummaryPage =
    | {
          items: CurrentAssetSummary[];
          totalCount: number;
          hasMore: false;
      }
    | {
          items: CurrentAssetSummary[];
          totalCount: number;
          hasMore: true;
          nextCursor: string;
      };

export interface AssetVersionSummary {
    assetId: UuidV4;
    versionId: UuidV4;
    revision: number;
    status: VersionStatus;
    fingerprint: Sha256Digest;
    originAuthorityFingerprint: Sha256Digest;
    versionCanonicalContentFingerprint: Sha256Digest;
    changeKind: "create" | "extract" | "edit" | "sync" | "rollback" | "merge";
    sourceVersionId: string;
    sourceDeploymentId: string;
    changeNote: string;
    fileCount: number;
    createdAt: EpochMillis;
}

export interface ListAssetVersionPageInput {
    assetId: UuidV4;
    pageSize?: number;
    cursor?: string;
}

export type AssetVersionPage =
    | {
          items: AssetVersionSummary[];
          totalCount: number;
          hasMore: false;
      }
    | {
          items: AssetVersionSummary[];
          totalCount: number;
          hasMore: true;
          nextCursor: string;
      };

export type AssetVersionFileTreeEntry =
    | {
          entryKind: "directory";
          relativeName: string;
          logicalPath: PosixRelativePath;
          descendantFileCount: number;
      }
    | {
          entryKind: "file";
          relativeName: string;
          file: AssetVersionFileV2;
      };

export interface ListAssetVersionFileChildrenInput {
    assetId: UuidV4;
    versionId: UuidV4;
    directoryPath: string;
    pageSize?: number;
    cursor?: string;
}

export type AssetVersionFileTreePage =
    | {
          entries: AssetVersionFileTreeEntry[];
          totalCount: number;
          hasMore: false;
      }
    | {
          entries: AssetVersionFileTreeEntry[];
          totalCount: number;
          hasMore: true;
          nextCursor: string;
      };

export interface ReadAssetVersionFilePreviewInput {
    assetId: UuidV4;
    versionId: UuidV4;
    logicalPath: PosixRelativePath;
}

export type AssetVersionFilePreview =
    | {
          previewKind: "text";
          file: AssetVersionFileV2;
          text: string;
          lineCount: number;
      }
    | {
          previewKind: "large_text";
          file: AssetVersionFileV2;
          limitReason: "byte_limit";
      }
    | {
          previewKind: "large_text";
          file: AssetVersionFileV2;
          limitReason: "line_limit";
          observedLineCount: number;
      }
    | {
          previewKind: "binary";
          file: AssetVersionFileV2;
      };

export interface ReadAssetVersionTextPageInput {
    assetId: UuidV4;
    versionId: UuidV4;
    logicalPath: PosixRelativePath;
    cursor?: string;
}

export type AssetVersionTextPage =
    | {
          file: AssetVersionFileV2;
          text: string;
          loadedByteStart: number;
          loadedByteEnd: number;
          totalBytes: number;
          firstLine: number;
          lastLine: number;
          totalLines: number;
          hasMore: false;
      }
    | {
          file: AssetVersionFileV2;
          text: string;
          loadedByteStart: number;
          loadedByteEnd: number;
          totalBytes: number;
          firstLine: number;
          lastLine: number;
          totalLines: number;
          hasMore: true;
          nextCursor: string;
      };
