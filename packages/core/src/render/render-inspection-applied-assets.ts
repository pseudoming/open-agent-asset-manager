/** Asset projections required by one rendered-target inspection partition. */

import type { RenderedTargetInspectionInput } from "../contracts/reverse";

export function projectAppliedAssetsForInspectionUnits(
    inspection: RenderedTargetInspectionInput,
    units: ReadonlySet<string>,
): RenderedTargetInspectionInput["appliedAssets"] {
    if (inspection.appliedAssets === undefined) return undefined;
    const versionKeys = new Set(
        inspection.appliedRenderSnapshot.decisions
            .filter((decision) => decision.outputUnitFingerprints.some((fingerprint) => units.has(fingerprint)))
            .map((decision) => `${decision.semanticRef.subject.assetId}\0${decision.semanticRef.subject.versionId}`),
    );
    for (const asset of inspection.appliedAssets) {
        if (
            !versionKeys.has(`${asset.version.ref.assetId}\0${asset.version.ref.versionId}`) ||
            asset.version.canonical.kind !== "Memory" ||
            asset.version.canonical.typeData.entityRole !== "catalog"
        ) {
            continue;
        }
        for (const memberAsset of inspection.appliedAssets) {
            if (
                memberAsset.version.canonical.kind === "Memory" &&
                memberAsset.version.canonical.typeData.entityRole === "unit" &&
                memberAsset.version.status === "complete" &&
                memberAsset.scope === asset.scope &&
                memberAsset.projectId === asset.projectId &&
                memberAsset.scopePath === asset.scopePath
            ) {
                versionKeys.add(`${memberAsset.version.ref.assetId}\0${memberAsset.version.ref.versionId}`);
            }
        }
    }
    const result = inspection.appliedAssets
        .filter((asset) => versionKeys.has(`${asset.version.ref.assetId}\0${asset.version.ref.versionId}`))
        .map((asset) => structuredClone(asset));
    return result.length === 0 ? undefined : result;
}
