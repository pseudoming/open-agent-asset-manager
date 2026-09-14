import type {
    AssetKindCount,
    AssetSummaryPage,
    AssetVersionFilePreview,
    AssetVersionFileTreePage,
    AssetVersionPage,
    AssetVersionTextPage,
    AssetVersionComparisonV1,
    ExportAssetVersionNativeFilesToFileResultV1,
    ExportAssetVersionToFileResultV1,
    CoreResult,
    LookupResult,
} from "@oaam/core";
import type { ProtocolOperationResult, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { projectCoreOutcome, projectLookup, toProtocolSha256 } from "./core-outcome";
import { projectAssetSummary } from "./core-projection";

export function projectAssetKindCounts(
    result: CoreResult<AssetKindCount[]>,
): ProtocolOperationResult<"asset_library.kind_counts"> {
    return projectCoreOutcome(result, (counts) => ({ counts: counts.map((item) => ({ ...item })) }));
}

export function projectAssetSummaryPage(result: CoreResult<AssetSummaryPage>): ProtocolOperationResult<"asset_library.page"> {
    return projectCoreOutcome(result, (page) =>
        page.hasMore
            ? {
                  assets: page.items.map(projectAssetSummary),
                  totalCount: page.totalCount,
                  hasMore: true,
                  nextCursor: page.nextCursor,
              }
            : {
                  assets: page.items.map(projectAssetSummary),
                  totalCount: page.totalCount,
                  hasMore: false,
              },
    );
}

export function projectAssetVersionPage(
    result: CoreResult<LookupResult<AssetVersionPage>>,
): ProtocolOperationResult<"asset_version.list"> {
    return projectCoreOutcome(result, (lookup) =>
        projectLookup(lookup, (page) =>
            page.hasMore
                ? {
                      versions: page.items.map(projectAssetVersionSummary),
                      totalCount: page.totalCount,
                      hasMore: true,
                      nextCursor: page.nextCursor,
                  }
                : {
                      versions: page.items.map(projectAssetVersionSummary),
                      totalCount: page.totalCount,
                      hasMore: false,
                  },
        ),
    );
}

export function projectAssetVersionFileTreePage(
    result: CoreResult<LookupResult<AssetVersionFileTreePage>>,
): ProtocolOperationResult<"asset_version.file_children"> {
    return projectCoreOutcome(result, (lookup) =>
        projectLookup(lookup, (page) =>
            page.hasMore
                ? {
                      entries: page.entries.map(projectFileTreeEntry),
                      totalCount: page.totalCount,
                      hasMore: true,
                      nextCursor: page.nextCursor,
                  }
                : {
                      entries: page.entries.map(projectFileTreeEntry),
                      totalCount: page.totalCount,
                      hasMore: false,
                  },
        ),
    );
}

export function projectAssetVersionFilePreview(
    result: CoreResult<LookupResult<AssetVersionFilePreview>>,
): ProtocolOperationResult<"asset_version.file_preview"> {
    return projectCoreOutcome(result, (lookup) =>
        projectLookup(lookup, (preview) => {
            const file = projectVersionFile(preview.file);
            switch (preview.previewKind) {
                case "text":
                    return {
                        previewKind: "text",
                        file,
                        text: preview.text,
                        lineCount: preview.lineCount,
                    };
                case "binary":
                    return { previewKind: "binary", file };
                case "large_text":
                    return preview.limitReason === "byte_limit"
                        ? { previewKind: "large_text", file, limitReason: "byte_limit" }
                        : {
                              previewKind: "large_text",
                              file,
                              limitReason: "line_limit",
                              observedLineCount: preview.observedLineCount,
                          };
            }
        }),
    );
}

export function projectAssetVersionTextPage(
    result: CoreResult<LookupResult<AssetVersionTextPage>>,
): ProtocolOperationResult<"asset_version.text_page"> {
    return projectCoreOutcome(result, (lookup) =>
        projectLookup(lookup, (page) =>
            page.hasMore
                ? {
                      ...page,
                      file: projectVersionFile(page.file),
                      nextCursor: page.nextCursor,
                  }
                : {
                      ...page,
                      file: projectVersionFile(page.file),
                  },
        ),
    );
}

export function projectAssetVersionComparison(
    result: CoreResult<AssetVersionComparisonV1>,
): ProtocolOperationTerminal<"asset_version.compare"> {
    return projectCoreOutcome(result, (comparison) => ({
        ...comparison,
        left: {
            ...comparison.left,
            versionFingerprint: toProtocolSha256(comparison.left.versionFingerprint),
        },
        right: {
            ...comparison.right,
            versionFingerprint: toProtocolSha256(comparison.right.versionFingerprint),
        },
        files: comparison.files.map((file) => ({
            ...file,
            left: projectFileSide(file.left),
            right: projectFileSide(file.right),
        })),
        selectedFile:
            comparison.selectedFile.comparisonKind === "not_requested"
                ? comparison.selectedFile
                : {
                      ...comparison.selectedFile,
                      left: projectFileSide(comparison.selectedFile.left),
                      right: projectFileSide(comparison.selectedFile.right),
                  },
    }));
}

export function projectAssetVersionExport(
    result: CoreResult<ExportAssetVersionToFileResultV1>,
): ProtocolOperationTerminal<"asset_version.export"> {
    return projectCoreOutcome(result, (exported) => ({
        ...exported,
        versionFingerprint: toProtocolSha256(exported.versionFingerprint),
        archiveIndexFingerprint: toProtocolSha256(exported.archiveIndexFingerprint),
    }));
}

export function projectAssetVersionNativeExport(
    result: CoreResult<ExportAssetVersionNativeFilesToFileResultV1>,
): ProtocolOperationTerminal<"asset_version.export_native"> {
    return projectCoreOutcome(result, (exported) => ({
        ...exported,
        versionFingerprint: toProtocolSha256(exported.versionFingerprint),
        representationFingerprint: toProtocolSha256(exported.representationFingerprint),
    }));
}

function projectAssetVersionSummary(version: AssetVersionPage["items"][number]) {
    return {
        ...version,
        fingerprint: toProtocolSha256(version.fingerprint),
        originAuthorityFingerprint: toProtocolSha256(version.originAuthorityFingerprint),
        versionCanonicalContentFingerprint: toProtocolSha256(version.versionCanonicalContentFingerprint),
    };
}

function projectFileTreeEntry(entry: AssetVersionFileTreePage["entries"][number]) {
    return entry.entryKind === "directory"
        ? { ...entry }
        : {
              entryKind: "file" as const,
              relativeName: entry.relativeName,
              file: projectVersionFile(entry.file),
          };
}

function projectVersionFile(file: AssetVersionFilePreview["file"]) {
    return {
        fileId: file.fileId,
        logicalPath: file.logicalPath,
        role: file.role,
        mediaType: file.mediaType,
        contentKind: file.contentKind,
        contentHash: toProtocolSha256(file.contentHash),
        byteLength: file.byteSize,
        executable: file.executable,
    };
}

function projectFileSide(side: AssetVersionComparisonV1["files"][number]["left"]) {
    return side.state === "missing" ? side : { state: "present" as const, file: projectVersionFile(side.file) };
}
