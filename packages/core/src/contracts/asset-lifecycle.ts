import type { AssetKind, AssetScope, Sha256Digest, UuidV4 } from "./primitives";

/**
 * Exact review material for recycling one already-soft-deleted OAAM Asset.
 *
 * The directory identity is represented by a fingerprint so the public Core
 * contract does not expose Shared's platform mechanism record. Commit reopens
 * the identity and passes the exact observed record to Shared for race-safe
 * Recycle Bin handoff.
 */
export interface AssetPurgePreparationV1 {
    readonly schemaVersion: 1;
    readonly action: "purge";
    readonly assetId: UuidV4;
    readonly assetManifestFingerprint: Sha256Digest;
    readonly assetDirectoryIdentityFingerprint: Sha256Digest;
    readonly kind: AssetKind;
    readonly scope: AssetScope;
    readonly projectId: string;
    readonly scopePath: string;
    readonly displayName: string;
    readonly versionCount: number;
    readonly promotionGrantCount: number;
}

export interface CommitAssetPurgeInputV1 {
    readonly preparation: AssetPurgePreparationV1;
    readonly userActionEvidenceId: string;
}

export interface AssetPurgeResultV1 {
    readonly assetId: UuidV4;
    readonly recycled: true;
}
