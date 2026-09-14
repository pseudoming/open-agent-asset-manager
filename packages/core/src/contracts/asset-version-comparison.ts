import type { AssetVersionFileV2 } from "./asset-version";
import type { PosixRelativePath, Sha256Digest, UuidV4 } from "./primitives";

export interface CompareAssetVersionsInputV1 {
    assetId: UuidV4;
    left: {
        versionId: UuidV4;
        versionFingerprint: Sha256Digest;
    };
    right: {
        versionId: UuidV4;
        versionFingerprint: Sha256Digest;
    };
    logicalPath?: PosixRelativePath;
}

export type AssetVersionFileSideV1 =
    | { state: "missing" }
    | {
          state: "present";
          file: AssetVersionFileV2;
      };

export interface AssetVersionFileChangeV1 {
    logicalPath: PosixRelativePath;
    changeKind: "added" | "removed" | "modified" | "unchanged";
    left: AssetVersionFileSideV1;
    right: AssetVersionFileSideV1;
}

export type AssetVersionDiffLineV1 =
    | {
          lineKind: "context";
          text: string;
          leftLine: number;
          rightLine: number;
      }
    | {
          lineKind: "remove";
          text: string;
          leftLine: number;
      }
    | {
          lineKind: "add";
          text: string;
          rightLine: number;
      };

export interface AssetVersionDiffHunkV1 {
    leftStart: number;
    leftLineCount: number;
    rightStart: number;
    rightLineCount: number;
    lines: AssetVersionDiffLineV1[];
}

export type SelectedAssetVersionFileComparisonV1 =
    | { comparisonKind: "not_requested" }
    | {
          comparisonKind: "metadata";
          logicalPath: PosixRelativePath;
          left: AssetVersionFileSideV1;
          right: AssetVersionFileSideV1;
      }
    | {
          comparisonKind: "text";
          logicalPath: PosixRelativePath;
          left: AssetVersionFileSideV1;
          right: AssetVersionFileSideV1;
          algorithm: "myers" | "coarse_complete";
          leftLineCount: number;
          rightLineCount: number;
          hunks: AssetVersionDiffHunkV1[];
      };

export interface AssetVersionComparisonV1 {
    schemaVersion: 1;
    assetId: UuidV4;
    left: {
        versionId: UuidV4;
        versionFingerprint: Sha256Digest;
    };
    right: {
        versionId: UuidV4;
        versionFingerprint: Sha256Digest;
    };
    files: AssetVersionFileChangeV1[];
    selectedFile: SelectedAssetVersionFileComparisonV1;
}

export type AssetVersionComparisonStage = "inventory" | "loading" | "diffing";

export interface AssetVersionComparisonProgressV1 {
    stage: AssetVersionComparisonStage;
    completedUnits: number;
    totalUnits: number;
}

export interface AssetVersionComparisonObserver {
    report(progress: AssetVersionComparisonProgressV1): void;
    isCancellationRequested(): boolean;
}
