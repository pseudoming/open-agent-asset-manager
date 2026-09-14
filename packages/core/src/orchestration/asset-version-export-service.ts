import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import { readAssetManifest } from "../catalog/asset-manifest";
import { readVersionAuthority } from "../catalog/version-authority";
import type {
    CoreResult,
    ExportAssetVersionNativeFilesToFileInputV1,
    ExportAssetVersionNativeFilesToFileResultV1,
    ExportAssetVersionToFileInputV1,
    ExportAssetVersionToFileResultV1,
    OperationDiagnostic,
} from "../types";
import { completeResult } from "../foundation/core-result";
import { isSha256Digest, isUuidV4 } from "../foundation/validators";
import { buildAndVerifyPortableAssetVersionArchive } from "./asset-version-archive";
import { buildAndVerifyNativeAssetVersionArchive } from "./asset-version-native-archive";

type DurableCreateFile = (filePath: string, data: Uint8Array) => unknown;

export async function exportAssetVersionToFile(
    assetsRoot: string,
    dialectRegistry: VersionDialectRegistryV1,
    now: () => number,
    durableCreateFile: DurableCreateFile,
    input: ExportAssetVersionToFileInputV1,
): Promise<CoreResult<ExportAssetVersionToFileResultV1>> {
    try {
        validateInput(input);
        const { asset, version } = readExactExportSource(assetsRoot, dialectRegistry, input);
        const archive = await buildAndVerifyPortableAssetVersionArchive({
            asset,
            version,
            dialectRegistry,
            exportedAt: now(),
        });
        durableCreateFile(input.destinationPath, archive.bytes);
        return completeResult({
            assetId: asset.assetId,
            versionId: version.manifest.versionId,
            versionFingerprint: version.manifest.fingerprint,
            archiveIndexFingerprint: archive.index.indexFingerprint,
            archiveByteLength: archive.bytes.byteLength,
        });
    } catch (error) {
        return failedExport(error);
    }
}

export async function exportAssetVersionNativeFilesToFile(
    assetsRoot: string,
    dialectRegistry: VersionDialectRegistryV1,
    now: () => number,
    durableCreateFile: DurableCreateFile,
    input: ExportAssetVersionNativeFilesToFileInputV1,
): Promise<CoreResult<ExportAssetVersionNativeFilesToFileResultV1>> {
    try {
        validateInput(input);
        const { asset, version } = readExactExportSource(assetsRoot, dialectRegistry, input);
        if (version.manifest.nativeRepresentations.length !== 1 || version.nativePayloads.length !== 1) {
            throw new Error("selected Version does not have exactly one directly exportable native representation");
        }
        const representation = version.manifest
            .nativeRepresentations[0] as (typeof version.manifest.nativeRepresentations)[number];
        const payload = version.nativePayloads[0] as (typeof version.nativePayloads)[number];
        const archive = await buildAndVerifyNativeAssetVersionArchive({ representation, payload, exportedAt: now() });
        durableCreateFile(input.destinationPath, archive.bytes);
        return completeResult({
            assetId: asset.assetId,
            versionId: version.manifest.versionId,
            versionFingerprint: version.manifest.fingerprint,
            dialectId: archive.dialectId,
            representationFingerprint: archive.representationFingerprint,
            fileCount: archive.fileCount,
            archiveByteLength: archive.bytes.byteLength,
        });
    } catch (error) {
        return failedNativeExport(error);
    }
}

function readExactExportSource(
    assetsRoot: string,
    dialectRegistry: VersionDialectRegistryV1,
    input: ExportAssetVersionToFileInputV1,
) {
    const asset = readAssetManifest(assetsRoot, input.source.assetId);
    if (asset === null || !asset.versionIds.includes(input.source.versionId)) {
        throw new Error("selected Version is not a member of the selected Asset");
    }
    const version = readVersionAuthority(assetsRoot, input.source.assetId, input.source.versionId, dialectRegistry);
    if (version === null) throw new Error("selected Version authority is unavailable");
    if (
        version.manifest.fingerprint !== input.source.versionFingerprint ||
        version.manifest.originAuthority.authorityFingerprint !== input.source.originAuthorityFingerprint
    ) {
        throw new Error("selected Version authority changed before export");
    }
    return { asset, version };
}

function validateInput(input: ExportAssetVersionToFileInputV1): void {
    if (!isUuidV4(input.source.assetId) || !isUuidV4(input.source.versionId)) {
        throw new Error("Asset and Version identities must be UUID v4");
    }
    if (!isSha256Digest(input.source.versionFingerprint) || !isSha256Digest(input.source.originAuthorityFingerprint)) {
        throw new Error("Version authority fingerprints must be SHA-256 digests");
    }
    if (
        input.destinationPath.length === 0 ||
        input.destinationPath.trim() !== input.destinationPath ||
        input.destinationPath.includes("\0")
    ) {
        throw new Error("export destination path is invalid");
    }
    if (
        input.userActionEvidenceId.length === 0 ||
        input.userActionEvidenceId.trim() !== input.userActionEvidenceId ||
        input.userActionEvidenceId.includes("\0")
    ) {
        throw new Error("export requires explicit user-action evidence");
    }
}

function failedExport(error: unknown): CoreResult<ExportAssetVersionToFileResultV1> {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: "asset_export.failed",
        message,
        path: "",
        traceId: "",
        operation: "version",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: message,
    };
    return {
        status: "failed",
        value: undefined as unknown as ExportAssetVersionToFileResultV1,
        diagnostics: [diagnostic],
    };
}

function failedNativeExport(error: unknown): CoreResult<ExportAssetVersionNativeFilesToFileResultV1> {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: "asset_native_export.failed",
        message,
        path: "",
        traceId: "",
        operation: "version",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: message,
    };
    return {
        status: "failed",
        value: undefined as unknown as ExportAssetVersionNativeFilesToFileResultV1,
        diagnostics: [diagnostic],
    };
}
