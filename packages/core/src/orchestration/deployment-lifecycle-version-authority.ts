/** Shared immutable Asset/Version checks used by reverse staging. */

import type { readAssetManifest } from "../catalog/asset-manifest";
import type { VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { UuidV4 } from "../types";
import { lifecycleFailure } from "./deployment-lifecycle-shared";

export function requireAvailableStagedAsset(
    asset: ReturnType<typeof readAssetManifest>,
    stagedVersionId: UuidV4,
): NonNullable<ReturnType<typeof readAssetManifest>> {
    if (asset === null || asset.deleted || asset.versionIds.includes(stagedVersionId)) {
        throw lifecycleFailure(
            "reverse_accept.asset_manifest_stale",
            "staged Version identity is not available in the active Asset",
            "conflict",
            true,
        );
    }
    return asset;
}

export function nextAssetRevision(
    asset: NonNullable<ReturnType<typeof readAssetManifest>>,
    resolveVersion: (versionId: UuidV4) => VersionAuthorityClosureV1 | null,
): number {
    const revisions = asset.versionIds.map((versionId) => {
        const closure = resolveVersion(versionId as UuidV4);
        if (closure === null) throw new Error("Asset manifest references a missing Version");
        return closure.manifest.revision;
    });
    return Math.max(...revisions) + 1;
}
