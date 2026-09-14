/** Stable scalar and closed-union contracts shared across Phase 17 owners. */

export type UuidV4 = string;
export type EpochMillis = number;
export type Sha256Digest = `sha256:${string}`;
export type PosixRelativePath = string;

export type Platform = "win32" | "darwin" | "linux" | "wsl";
export type AgentRuntimeId = string;
export type AdapterId = string;
export type OperationStatus = "complete" | "partial" | "failed";

export type AssetKind = "Guidance" | "Rule" | "Workflow" | "Skill" | "Subagent" | "Memory";

export type AssetScope = "global" | "project";
export type VersionStatus = "complete" | "incomplete";
export type FileRole = "entry" | "resource" | "dependency";
export type ContentKind = "text" | "binary";
export type ReferenceKind = "include" | "link" | "execute";
