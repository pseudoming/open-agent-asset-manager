import type { RequiredRenderSemantic } from "../contracts/deployment-authority";
import type { ProviderRenderDialectInputsForAsset, RenderAssetInput } from "../contracts/render";
import type { VersionRef } from "../types";
import { versionRefKey } from "./render-semantics";

export function renderDialectScopeKey(consumerAgentRuntimeId: string, version: VersionRef): string {
    return `${consumerAgentRuntimeId}\0${versionRefKey(version)}`;
}

/** Memory members inherit the consumer of the Catalog semantic that reaches them. */
export function renderDialectScopes(
    semantics: readonly RequiredRenderSemantic[],
    assets: readonly RenderAssetInput[],
): Set<string> {
    const scopes = new Set<string>();
    const byVersion = new Map(assets.map((asset) => [versionRefKey(asset.version.ref), asset]));
    const byVersionId = new Map(assets.map((asset) => [asset.version.ref.versionId, asset]));
    for (const semantic of semantics) {
        scopes.add(renderDialectScopeKey(semantic.consumerAgentRuntimeId, semantic.subject));
        const asset = byVersion.get(versionRefKey(semantic.subject));
        if (asset?.version.canonical.kind !== "Memory" || asset.version.canonical.typeData.entityRole !== "catalog") continue;
        for (const member of asset.version.canonical.typeData.members) {
            const unit = byVersionId.get(member.targetAssetVersionId);
            if (unit?.version.canonical.kind === "Memory" && unit.version.canonical.typeData.entityRole === "unit") {
                scopes.add(renderDialectScopeKey(semantic.consumerAgentRuntimeId, unit.version.ref));
            }
        }
    }
    return scopes;
}

/** Pure projection for one handler or selected output unit; it performs no physical reads. */
export function projectRenderDialectInputs(
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[],
    semantics: readonly RequiredRenderSemantic[],
    assets: readonly RenderAssetInput[],
): ProviderRenderDialectInputsForAsset[] {
    const scopes = renderDialectScopes(semantics, assets);
    return dialectInputs.flatMap((group) => {
        const consumers = group.consumerAgentRuntimeIds.filter((consumer) =>
            scopes.has(renderDialectScopeKey(consumer, group.targetVersion)),
        );
        return consumers.length === 0
            ? []
            : [
                  {
                      ...group,
                      consumerAgentRuntimeIds: consumers as ProviderRenderDialectInputsForAsset["consumerAgentRuntimeIds"],
                  },
              ];
    });
}
