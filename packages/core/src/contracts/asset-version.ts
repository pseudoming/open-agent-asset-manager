import type { Diagnostic } from "./common";
import type {
    ContentKind,
    EpochMillis,
    FileRole,
    PosixRelativePath,
    ReferenceKind,
    Sha256Digest,
    UuidV4,
    VersionStatus,
} from "./primitives";
import type { PersistedVersionAuthorityFieldsV1, PersistedVersionSourceAuthorityV1 } from "./persistence";
import type { AssetKindTypeDataV2 } from "./specs";

export interface FileReferenceBaseV2 {
    kind: ReferenceKind;
    rawTarget: string;
    required: boolean;
    diagnostics: Diagnostic[];
}

export type FileReferenceV2 =
    | (FileReferenceBaseV2 & {
          resolution: "resolved_version_file";
          targetLogicalPath: PosixRelativePath;
      })
    | (FileReferenceBaseV2 & {
          resolution: "resolved_asset_version";
          targetAssetVersionId: UuidV4;
      })
    | (FileReferenceBaseV2 & {
          resolution: "unresolved" | "external" | "forbidden";
      });

export interface AssetVersionFileV2 {
    fileId: UuidV4;
    logicalPath: PosixRelativePath;
    role: FileRole;
    contentHash: Sha256Digest;
    contentKind: ContentKind;
    mediaType: string;
    byteSize: number;
    executable: boolean;
    references: FileReferenceV2[];
}

export interface AssetVersionManifestBaseV2 {
    schemaVersion: 2;
    versionId: UuidV4;
    assetId: UuidV4;
    revision: number;
    fingerprint: Sha256Digest;
    status: VersionStatus;
    diagnostics: Diagnostic[];
    files: AssetVersionFileV2[];
    changeKind: "create" | "extract" | "edit" | "sync" | "rollback" | "merge";
    sourceVersionId: string;
    sourceDeploymentId: string;
    changeNote: string;
    createdAt: EpochMillis;
}

export type AssetVersionManifestV2 = AssetVersionManifestBaseV2 &
    AssetKindTypeDataV2 &
    PersistedVersionAuthorityFieldsV1 &
    PersistedVersionSourceAuthorityV1;

export type AssetVersionFileContentV2 =
    | {
          file: AssetVersionFileV2;
          contentKind: "text";
          text: string;
      }
    | {
          file: AssetVersionFileV2;
          contentKind: "binary";
          bytes: Uint8Array;
      };
