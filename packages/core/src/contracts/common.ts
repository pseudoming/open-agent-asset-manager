import type { UuidV4 } from "./primitives";

export interface Diagnostic {
    severity: "info" | "warning" | "error";
    code: string;
    message: string;
    path: string;
    traceId: string;
}

export type SuggestedAction =
    | "retry"
    | "grant_permission"
    | "install_runtime"
    | "upgrade_runtime"
    | "upgrade_adapter"
    | "choose_target"
    | "rebuild_deployment"
    | "skip"
    | "contact_support";

export interface OperationDiagnostic extends Diagnostic {
    operation:
        | "project"
        | "asset"
        | "version"
        | "probe"
        | "read"
        | "render"
        | "deploy"
        | "scan"
        | "search"
        | "reindex"
        | "settings"
        | "backup"
        | "restore"
        | "reverse_accept"
        | "internal";
    causeKind:
        | "not_found"
        | "unavailable"
        | "permission_denied"
        | "version_incompatible"
        | "partial"
        | "invalid_schema"
        | "unsupported"
        | "conflict"
        | "verification_failed"
        | "internal_error";
    retryable: boolean;
    suggestedActions: SuggestedAction[];
    rawSummary: string;
}

export interface ToolSelectorV1 {
    dialectId: string;
    selector: string;
}

export interface VersionRef {
    assetId: UuidV4;
    versionId: UuidV4;
}

export type TargetFileContent = { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
