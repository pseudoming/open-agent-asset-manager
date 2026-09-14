export const IMPORT_PREVIEW_FILE_REVEAL_CHANNEL = "oaam:desktop-import-preview-file-reveal";

export interface DesktopImportPreviewFileReference {
    readonly previewToken: string;
    readonly candidateId: string;
    readonly logicalPath?: string;
}

export type ImportPreviewFileRevealResult =
    | { readonly status: "complete" }
    | { readonly status: "failed"; readonly code: "unavailable" | "open_failed" };

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

export function parseDesktopImportPreviewFileReference(value: unknown): DesktopImportPreviewFileReference {
    const keys =
        typeof value === "object" && value !== null && "logicalPath" in value
            ? ["candidateId", "logicalPath", "previewToken"]
            : ["candidateId", "previewToken"];
    if (
        !isExactRecord(value, keys) ||
        !isNonEmptyString(value.previewToken) ||
        !isNonEmptyString(value.candidateId) ||
        ("logicalPath" in value && !isNonEmptyString(value.logicalPath))
    ) {
        throw new TypeError("invalid Desktop import-preview file reference");
    }
    return Object.freeze({
        previewToken: value.previewToken,
        candidateId: value.candidateId,
        ...("logicalPath" in value ? { logicalPath: value.logicalPath as string } : {}),
    });
}

export function parseImportPreviewFileRevealResult(value: unknown): ImportPreviewFileRevealResult {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["code", "status"]) &&
        value.status === "failed" &&
        (value.code === "unavailable" || value.code === "open_failed")
    ) {
        return Object.freeze({ status: "failed", code: value.code });
    }
    throw new TypeError("invalid Desktop import-preview file reveal result");
}
