import type { CoreResult, CurrentAssetSummary } from "@oaam/core";
import type { ProtocolOperationResult } from "@oaam/app-server-protocol";
import { hostInvocationFailure, projectCoreOutcome, toProtocolSha256 } from "./core-outcome";

type AssetListOutcome = ProtocolOperationResult<"asset.list">;

export function projectAssetSummary(asset: CurrentAssetSummary) {
    return {
        assetId: asset.assetId,
        kind: asset.kind,
        scope: asset.scope,
        ...(asset.projectId === "" ? {} : { projectId: asset.projectId }),
        scopePath: asset.scopePath,
        displayName: asset.displayName,
        displayDescription: asset.displayDescription,
        currentVersionId: asset.currentVersionId,
        currentRevision: asset.currentRevision,
        currentFingerprint: toProtocolSha256(asset.currentFingerprint),
        currentVersionStatus: asset.currentVersionStatus,
        deleted: asset.deleted,
        createdAt: asset.assetCreatedAt,
        updatedAt: asset.assetUpdatedAt,
    };
}

export function projectAssetListResult(result: CoreResult<CurrentAssetSummary[]>): AssetListOutcome {
    return projectCoreOutcome(result, (assets) => ({ assets: assets.map(projectAssetSummary) }));
}

export { hostInvocationFailure };
