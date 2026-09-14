import type { AssetScope, EpochMillis, PosixRelativePath, Sha256Digest, UuidV4 } from "./primitives";

export interface PortableAssetVersionArchiveFileV1 {
    logicalPath: PosixRelativePath;
    archivePath: PosixRelativePath;
}

export interface PortableAssetVersionArchiveNativeRepresentationV1 {
    dialectId: string;
    files: Array<{
        relativePath: PosixRelativePath;
        archivePath: PosixRelativePath;
    }>;
}

export interface PortableAssetVersionArchiveRestorationPayloadV1 {
    dialectId: string;
    archivePath: PosixRelativePath;
    byteSize: number;
}

export interface PortableAssetVersionArchiveIndexV1 {
    schemaVersion: 1;
    archiveFormat: "oaam_asset_version";
    exportedAt: EpochMillis;
    sourceAsset: {
        assetId: UuidV4;
        displayName: string;
        displayDescription: string;
        scope: AssetScope;
        projectId: string;
        scopePath: string;
    };
    version: {
        versionId: UuidV4;
        fingerprint: Sha256Digest;
        manifestPath: "metadata/version.json";
    };
    canonicalFiles: PortableAssetVersionArchiveFileV1[];
    nativeRepresentations: PortableAssetVersionArchiveNativeRepresentationV1[];
    restorationPayloads: PortableAssetVersionArchiveRestorationPayloadV1[];
    indexFingerprint: Sha256Digest;
}

export interface ExportAssetVersionToFileInputV1 {
    source: {
        assetId: UuidV4;
        versionId: UuidV4;
        versionFingerprint: Sha256Digest;
        originAuthorityFingerprint: Sha256Digest;
    };
    destinationPath: string;
    userActionEvidenceId: string;
}

export interface ExportAssetVersionToFileResultV1 {
    assetId: UuidV4;
    versionId: UuidV4;
    versionFingerprint: Sha256Digest;
    archiveIndexFingerprint: Sha256Digest;
    archiveByteLength: number;
}

export interface ExportAssetVersionNativeFilesToFileInputV1 extends ExportAssetVersionToFileInputV1 {}

export interface ExportAssetVersionNativeFilesToFileResultV1 {
    assetId: UuidV4;
    versionId: UuidV4;
    versionFingerprint: Sha256Digest;
    dialectId: string;
    representationFingerprint: Sha256Digest;
    fileCount: number;
    archiveByteLength: number;
}
