import type { AssetPurgePreparationV1, AssetPurgeResultV1, CopyAssetVersionToLocationResultV1, CoreResult } from "@oaam/core";
import type { ProtocolOperationResult, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { projectAsset, projectAssetVersionManifest } from "./catalog-projection";
import { projectCoreOutcome, toProtocolSha256 } from "./core-outcome";

export function projectAssetCopy(result: CoreResult<CopyAssetVersionToLocationResultV1>): ProtocolOperationResult<"asset.copy"> {
    return projectCoreOutcome(result, (copied) => ({
        source: { ...copied.source },
        asset: projectAsset(copied.asset),
        version: projectAssetVersionManifest(copied.version),
    }));
}

export function projectAssetPurgePreparation(
    result: CoreResult<AssetPurgePreparationV1>,
): ProtocolOperationResult<"asset.purge.inspect"> {
    return projectCoreOutcome(result, (preparation) => ({
        ...preparation,
        assetManifestFingerprint: toProtocolSha256(preparation.assetManifestFingerprint),
        assetDirectoryIdentityFingerprint: toProtocolSha256(preparation.assetDirectoryIdentityFingerprint),
    }));
}

export function projectAssetPurgeResult(result: CoreResult<AssetPurgeResultV1>): ProtocolOperationTerminal<"asset.purge.commit"> {
    return projectCoreOutcome(result, (value) => ({ ...value }));
}
