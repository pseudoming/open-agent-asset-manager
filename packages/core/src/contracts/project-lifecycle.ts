import type { Sha256Digest, UuidV4 } from "./primitives";

export interface InspectProjectRenameInputV1 {
    readonly action: "rename";
    readonly projectId: UuidV4;
    readonly nextDisplayName: string;
}

export interface InspectProjectRebindInputV1 {
    readonly action: "rebind";
    readonly projectId: UuidV4;
    readonly nextRootPath: string;
}

export interface InspectProjectRestoreInputV1 {
    readonly action: "restore";
    readonly projectId: UuidV4;
}

export interface InspectProjectStopManagingInputV1 {
    readonly action: "stop_managing";
    readonly projectId: UuidV4;
}

export type InspectProjectLifecycleInputV1 =
    | InspectProjectRenameInputV1
    | InspectProjectRebindInputV1
    | InspectProjectRestoreInputV1
    | InspectProjectStopManagingInputV1;

export interface ProjectRenamePreparationV1 {
    readonly schemaVersion: 1;
    readonly action: "rename";
    readonly projectId: UuidV4;
    readonly projectAuthorityFingerprint: Sha256Digest;
    readonly rootPath: string;
    readonly currentDisplayName: string;
    readonly nextDisplayName: string;
}

export interface ProjectRebindPreparationV1 {
    readonly schemaVersion: 1;
    readonly action: "rebind";
    readonly projectId: UuidV4;
    readonly projectAuthorityFingerprint: Sha256Digest;
    readonly displayName: string;
    readonly currentRootPath: string;
    readonly nextRootPath: string;
}

export interface ProjectRestorePreparationV1 {
    readonly schemaVersion: 1;
    readonly action: "restore";
    readonly projectId: UuidV4;
    readonly projectAuthorityFingerprint: Sha256Digest;
    readonly displayName: string;
    readonly rootPath: string;
    readonly rootAccessState: "available" | "unavailable";
}

export interface ProjectStopManagingPreparationV1 {
    readonly schemaVersion: 1;
    readonly action: "stop_managing";
    readonly projectId: UuidV4;
    readonly projectAuthorityFingerprint: Sha256Digest;
    readonly displayName: string;
    readonly rootPath: string;
}

export type ProjectLifecyclePreparationV1 =
    | ProjectRenamePreparationV1
    | ProjectRebindPreparationV1
    | ProjectRestorePreparationV1
    | ProjectStopManagingPreparationV1;

export interface CommitProjectLifecycleInputV1 {
    readonly preparation: ProjectLifecyclePreparationV1;
    readonly userActionId: string;
}
