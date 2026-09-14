import * as path from "node:path";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import type { AssetVersionManifestV2, UuidV4 } from "../types";
import { isUuidV4 } from "../foundation/validators";
import { readAssetManifest, resolveAssetRoot } from "./asset-manifest";
import { parseVersionManifest } from "./version-manifest";

/**
 * Read strict Version metadata without opening canonical/native/restoration
 * payloads. Missing Assets or non-member Versions are ordinary lookup misses;
 * missing/corrupt authority below a declared member remains an error.
 */
export function readAssetVersionManifest(assetsRoot: string, assetId: UuidV4, versionId: UuidV4): AssetVersionManifestV2 | null {
    if (!isUuidV4(assetId) || !isUuidV4(versionId)) throw new Error("Asset and Version identities must be UUID v4");
    const asset = readAssetManifest(assetsRoot, assetId);
    if (asset === null || !asset.versionIds.includes(versionId)) return null;
    const versionRoot = path.join(resolveAssetRoot(assetsRoot, assetId), "versions", versionId);
    const manifest = parseVersionManifest(
        Buffer.from(readRegularFileNoFollow(path.join(versionRoot, "version.json")).bytes).toString("utf-8"),
    );
    if (manifest.assetId !== assetId || manifest.versionId !== versionId || manifest.kind !== asset.kind) {
        throw new Error("Version manifest identity does not match its enclosing Asset authority");
    }
    return manifest;
}

export function resolveAssetVersionRoot(assetsRoot: string, assetId: UuidV4, versionId: UuidV4): string {
    if (!isUuidV4(assetId) || !isUuidV4(versionId)) throw new Error("Asset and Version identities must be UUID v4");
    return path.join(resolveAssetRoot(assetsRoot, assetId), "versions", versionId);
}
