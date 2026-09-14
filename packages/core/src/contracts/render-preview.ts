import type { PosixRelativePath, Sha256Digest, UuidV4 } from "./primitives";
import type { RenderSelectionRequest } from "./render";

export interface PreviewDeploymentRenderInput {
    deploymentId: UuidV4;
    selectionRequest: RenderSelectionRequest;
}

export type DeploymentPreviewContent =
    | {
          contentKind: "text";
          contentHash: Sha256Digest;
          byteSize: number;
          executable: boolean;
          text: string;
      }
    | {
          contentKind: "binary";
          contentHash: Sha256Digest;
          byteSize: number;
          executable: boolean;
      };

export type DeploymentPreviewFileState = { state: "missing" } | ({ state: "present" } & DeploymentPreviewContent);

export type DeploymentPreviewChangeKind =
    | "create"
    | "unchanged"
    | "update_managed"
    | "remove_managed"
    | "establish_baseline"
    | "replace_unmanaged"
    | "managed_conflict";

export interface DeploymentPreviewFile {
    relativePath: PosixRelativePath;
    baselineState: "unmanaged" | "managed";
    changeKind: DeploymentPreviewChangeKind;
    current: DeploymentPreviewFileState;
    desired: DeploymentPreviewFileState;
}

export type DeploymentPreviewDirectoryChangeKind = "create" | "unchanged" | "remove_managed" | "remove_unmanaged";

export interface DeploymentPreviewDirectory {
    /** Exact complete-directory leaf that grants authority for this descendant. */
    managedBoundaryRelativePath: PosixRelativePath;
    relativePath: PosixRelativePath;
    baselineState: "unmanaged" | "managed";
    changeKind: DeploymentPreviewDirectoryChangeKind;
    currentState: "missing" | "present";
    desiredState: "missing" | "present";
}

export interface DeploymentRenderPreviewView {
    schemaVersion: 3;
    deploymentId: UuidV4;
    renderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    compilationFingerprint: Sha256Digest;
    previewFingerprint: Sha256Digest;
    replacementScope: DeploymentPreviewReplacementScope;
    actionState: "ready_apply" | "requires_unmanaged_replacement" | "blocked_managed_conflict";
    files: DeploymentPreviewFile[];
    directories: DeploymentPreviewDirectory[];
}

/** Complete physical targets superseded by the confirmed Version, including later content edits. */
export interface DeploymentPreviewReplacementScope {
    filePaths: PosixRelativePath[];
    directoryPaths: PosixRelativePath[];
}

type FingerprintedPreviewFileState =
    | { state: "missing" }
    | {
          state: "present";
          contentKind: DeploymentPreviewContent["contentKind"];
          contentHash: Sha256Digest;
          byteSize: number;
          executable: boolean;
      };

/** Desired authority is fixed; observations remain binding only outside complete replacement scope. */
export interface DeploymentRenderPreviewFingerprintInput {
    deploymentId: UuidV4;
    renderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    compilationFingerprint: Sha256Digest;
    replacementScope: DeploymentPreviewReplacementScope;
    desiredFiles: {
        relativePath: PosixRelativePath;
        desired: FingerprintedPreviewFileState;
    }[];
    desiredDirectories: {
        managedBoundaryRelativePath: PosixRelativePath;
        relativePath: PosixRelativePath;
    }[];
    protectedFiles: {
        relativePath: PosixRelativePath;
        baselineState: DeploymentPreviewFile["baselineState"];
        changeKind: DeploymentPreviewChangeKind;
        current: FingerprintedPreviewFileState;
        desired: FingerprintedPreviewFileState;
    }[];
    protectedDirectories: {
        managedBoundaryRelativePath: PosixRelativePath;
        relativePath: PosixRelativePath;
        baselineState: DeploymentPreviewDirectory["baselineState"];
        changeKind: DeploymentPreviewDirectoryChangeKind;
        currentState: "missing" | "present";
        desiredState: "missing" | "present";
    }[];
}
