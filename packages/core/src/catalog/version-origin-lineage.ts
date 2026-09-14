/** Pure promotion-safety resolution across immutable Version origin lineage. */

import type { ImportProvenanceAuthority } from "../contracts/persistence";
import type { UuidV4 } from "../contracts/primitives";
import type { VersionAuthorityClosureV1 } from "./version-authority";

export type VersionSourcePromotionSafety = "default_promotable" | "requires_user_confirmation" | null;

export type VersionSourcePromotionSafetyResolution =
    | { status: "resolved"; promotionSafety: VersionSourcePromotionSafety }
    | { status: "broken"; message: string };

export function resolveVersionSourcePromotionSafety(
    closure: VersionAuthorityClosureV1,
    resolveVersion: (assetId: UuidV4, versionId: UuidV4) => VersionAuthorityClosureV1 | null,
): VersionSourcePromotionSafetyResolution {
    return resolveLineage(closure, resolveVersion, new Set());
}

function resolveLineage(
    closure: VersionAuthorityClosureV1,
    resolveVersion: (assetId: UuidV4, versionId: UuidV4) => VersionAuthorityClosureV1 | null,
    visited: Set<string>,
): VersionSourcePromotionSafetyResolution {
    const identity = `${closure.manifest.assetId}\0${closure.manifest.versionId}`;
    if (visited.has(identity)) {
        return { status: "broken", message: "Version origin lineage contains a cycle" };
    }
    visited.add(identity);
    const origin = closure.manifest.originAuthority;
    if (origin.originKind === "import") {
        const imported = closure.manifest as typeof closure.manifest & {
            importProvenanceAuthority: ImportProvenanceAuthority;
        };
        return { status: "resolved", promotionSafety: imported.importProvenanceAuthority.promotionSafety };
    }
    if (origin.originKind === "user_created") {
        return { status: "resolved", promotionSafety: null };
    }
    if (origin.originKind === "asset_copy") {
        return {
            status: "resolved",
            promotionSafety: origin.sourcePromotionSafety === "not_applicable" ? null : origin.sourcePromotionSafety,
        };
    }
    const parent = resolveVersion(closure.manifest.assetId, origin.previousVersionId);
    if (
        parent === null ||
        parent.manifest.originAuthority.authorityFingerprint !== origin.previousVersionOriginAuthorityFingerprint
    ) {
        return { status: "broken", message: "reverse origin cannot resolve its exact parent authority" };
    }
    return resolveLineage(parent, resolveVersion, visited);
}
