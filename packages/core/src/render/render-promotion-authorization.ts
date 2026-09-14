import { readAssetManifest } from "../catalog/asset-manifest";
import {
    listPromotionGrantAuthorities,
    resolvePromotionGrantAuthority,
    validatePromotionGrantForPendingVersion,
} from "../catalog/promotion-grant-store";
import { getRestrictedSourceFullAccessAuthority } from "../catalog/settings-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-authority";
import { readVersionAuthority, type VersionAuthorityClosureV1 } from "../catalog/version-authority";
import { resolveVersionSourcePromotionSafety } from "../catalog/version-origin-lineage";
import type { PromotionAuthorizationInspection, ResolvedPromotionAuthorization } from "../contracts/deployment-authority";
import type {
    PromotionGrantTarget,
    PromotionGrantV1,
    RestrictedSourcePromotionFullAccessSettingV1,
    VersionPromotionRequirement,
} from "../contracts/persistence";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { RenderDeploymentInput } from "../contracts/render";
import { computeGlobalPromotionTargetAuthorityFingerprint, stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import type { CoreResult, OperationDiagnostic } from "../types";
import { failedRenderSelectionResult, RenderSelectionFailure } from "./render-selection-guards";

interface PromotionAuthorizationConfiguration {
    readonly assetsRoot: string;
    readonly oaamRoot: string;
    readonly dialectRegistry: VersionDialectRegistryV1;
}

type PromotionAuthorizationAuthority =
    | { readonly authorityKind: "none" }
    | { readonly authorityKind: "grant"; readonly grant: PromotionGrantV1 }
    | {
          readonly authorityKind: "restricted_source_full_access";
          readonly setting: Extract<RestrictedSourcePromotionFullAccessSettingV1, { state: "enabled" }>;
      };

interface PromotionAuthorizationInspectionFacts {
    readonly assetId: UuidV4;
    readonly versionId: UuidV4;
    readonly target: PromotionGrantTarget;
    readonly promotionRequirement: VersionPromotionRequirement;
    readonly versionOriginAuthorityFingerprint: Sha256Digest;
    readonly authority: PromotionAuthorizationAuthority;
}

/** @internal Shared by the authority loader and the real-component rehearsal fixture. */
export function resolvePromotionAuthorizationInspectionFromFacts(
    input: PromotionAuthorizationInspectionFacts,
): Exclude<PromotionAuthorizationInspection, { promotionAuthorizationState: "unavailable" }> {
    const base = {
        assetId: input.assetId,
        versionId: input.versionId,
        target: structuredClone(input.target),
        versionOriginAuthorityFingerprint: input.versionOriginAuthorityFingerprint,
    };
    if (input.promotionRequirement === "not_required") {
        return { ...base, promotionAuthorizationState: "not_required" };
    }
    if (input.authority.authorityKind === "grant") {
        const grant = input.authority.grant;
        return {
            ...base,
            promotionAuthorizationState: "authorized",
            authorizationSource:
                grant.subject.subjectKind === "asset_version" ? "version_target_grant" : "asset_all_versions_target_grant",
            authorityId: grant.promotionGrantId,
            authorityRevision: grant.revision,
            authorityFingerprint: grant.grantFingerprint,
        };
    }
    if (input.authority.authorityKind === "restricted_source_full_access") {
        const setting = input.authority.setting;
        return {
            ...base,
            promotionAuthorizationState: "authorized",
            authorizationSource: "restricted_source_full_access",
            authorityId: setting.settingId,
            authorityRevision: setting.revision,
            authorityFingerprint: setting.settingFingerprint,
        };
    }
    return { ...base, promotionAuthorizationState: "required" };
}

/** Fresh read-only inspection; it never grants authority or weakens selection. */
export function inspectPromotionAuthorizations(
    deployment: RenderDeploymentInput,
    configuration: PromotionAuthorizationConfiguration,
): CoreResult<PromotionAuthorizationInspection[]> {
    const target = promotionTargetForDeployment(deployment);
    const diagnostics: OperationDiagnostic[] = [];
    const inspections = deployment.assets.map((asset): PromotionAuthorizationInspection => {
        try {
            return resolvePromotionAuthorizationForAsset(deployment, asset, configuration, null);
        } catch (error) {
            const failure = normalizePromotionAuthorizationFailure(error);
            const diagnostic = failedRenderSelectionResult<never>(failure).diagnostics[0] as OperationDiagnostic;
            diagnostics.push(diagnostic);
            return {
                promotionAuthorizationState: "unavailable",
                assetId: asset.version.ref.assetId,
                versionId: asset.version.ref.versionId,
                target: structuredClone(target),
                diagnosticCode: diagnostic.code,
            };
        }
    });
    inspections.sort((left, right) =>
        compareUtf8Bytes(
            `${left.assetId}\0${left.versionId}\0${stableStringify(left.target)}`,
            `${right.assetId}\0${right.versionId}\0${stableStringify(right.target)}`,
        ),
    );
    return { status: diagnostics.length === 0 ? "complete" : "partial", value: inspections, diagnostics };
}

/** One unpublished reverse-accept Version resolved under the owning Asset lease. */
export interface StagedRenderSelectionAuthority {
    version: VersionAuthorityClosureV1;
    promotionGrant?: PromotionGrantV1;
}

/** @internal Selection reuses the same fresh Core-owned authorization authority. */
export function resolvePromotionAuthorizations(
    deployment: RenderDeploymentInput,
    configuration: PromotionAuthorizationConfiguration,
    staged: StagedRenderSelectionAuthority | null,
): ResolvedPromotionAuthorization[] {
    return deployment.assets
        .map((inputAsset): ResolvedPromotionAuthorization => {
            const inspection = resolvePromotionAuthorizationForAsset(deployment, inputAsset, configuration, staged);
            if (inspection.promotionAuthorizationState === "required") {
                throw new RenderSelectionFailure(
                    "render.promotion_authorization_required",
                    "Version requires an exact current promotion authorization",
                    "conflict",
                );
            }
            return inspection;
        })
        .sort((left, right) =>
            compareUtf8Bytes(
                `${left.assetId}\0${left.versionId}\0${stableStringify(left.target)}`,
                `${right.assetId}\0${right.versionId}\0${stableStringify(right.target)}`,
            ),
        );
}

function resolvePromotionAuthorizationForAsset(
    deployment: RenderDeploymentInput,
    inputAsset: RenderDeploymentInput["assets"][number],
    configuration: PromotionAuthorizationConfiguration,
    staged: StagedRenderSelectionAuthority | null,
): Exclude<PromotionAuthorizationInspection, { promotionAuthorizationState: "unavailable" }> {
    try {
        const target = promotionTargetForDeployment(deployment);
        const asset = readAssetManifest(configuration.assetsRoot, inputAsset.version.ref.assetId);
        const isStaged =
            staged !== null &&
            staged.version.manifest.assetId === inputAsset.version.ref.assetId &&
            staged.version.manifest.versionId === inputAsset.version.ref.versionId;
        if (
            asset === null ||
            asset.deleted ||
            (isStaged
                ? staged.version.manifest.originAuthority.originKind !== "reverse_accept" ||
                  !asset.versionIds.includes(staged.version.manifest.originAuthority.previousVersionId) ||
                  asset.versionIds.includes(inputAsset.version.ref.versionId)
                : !asset.versionIds.includes(inputAsset.version.ref.versionId)) ||
            asset.scope !== inputAsset.scope ||
            asset.projectId !== inputAsset.projectId ||
            asset.scopePath !== inputAsset.scopePath
        ) {
            throw new RenderSelectionFailure(
                "render.promotion_asset_stale",
                "render Asset authority changed before authorization",
                "conflict",
                true,
            );
        }
        const closure = isStaged
            ? staged.version
            : readVersionAuthority(
                  configuration.assetsRoot,
                  asset.assetId,
                  inputAsset.version.ref.versionId,
                  configuration.dialectRegistry,
              );
        if (closure === null || !projectionMatchesClosure(inputAsset, closure)) {
            throw new RenderSelectionFailure(
                "render.promotion_version_stale",
                "render Version projection no longer matches its authority",
                "conflict",
                true,
            );
        }
        const origin = closure.manifest.originAuthority;
        if (origin.promotionRequirement === "not_required") {
            return resolvePromotionAuthorizationInspectionFromFacts({
                assetId: asset.assetId,
                versionId: closure.manifest.versionId,
                target,
                promotionRequirement: origin.promotionRequirement,
                versionOriginAuthorityFingerprint: origin.authorityFingerprint,
                authority: { authorityKind: "none" },
            });
        }
        const grant = isStaged
            ? resolvePendingPromotionGrant(
                  configuration.assetsRoot,
                  asset.assetId,
                  closure.manifest.versionId,
                  target,
                  staged.promotionGrant,
                  asset.versionIds,
              )
            : resolvePromotionGrantAuthority({
                  assetsRoot: configuration.assetsRoot,
                  assetId: asset.assetId,
                  versionId: closure.manifest.versionId,
                  target,
              });
        if (grant !== null) {
            return resolvePromotionAuthorizationInspectionFromFacts({
                assetId: asset.assetId,
                versionId: closure.manifest.versionId,
                target,
                promotionRequirement: origin.promotionRequirement,
                versionOriginAuthorityFingerprint: origin.authorityFingerprint,
                authority: { authorityKind: "grant", grant },
            });
        }
        const fullAccess = getRestrictedSourceFullAccessAuthority(configuration.oaamRoot);
        const fullAccessApplies =
            fullAccess.state === "enabled" &&
            resolveImportedPromotionSafety(configuration, closure) === "requires_user_confirmation";
        return resolvePromotionAuthorizationInspectionFromFacts({
            assetId: asset.assetId,
            versionId: closure.manifest.versionId,
            target,
            promotionRequirement: origin.promotionRequirement,
            versionOriginAuthorityFingerprint: origin.authorityFingerprint,
            authority: fullAccessApplies
                ? { authorityKind: "restricted_source_full_access", setting: fullAccess }
                : { authorityKind: "none" },
        });
    } catch (error) {
        throw normalizePromotionAuthorizationFailure(error);
    }
}

function normalizePromotionAuthorizationFailure(error: unknown): RenderSelectionFailure {
    return error instanceof RenderSelectionFailure
        ? error
        : new RenderSelectionFailure(
              "render.promotion_authority_unavailable",
              "Promotion authorization authority could not be verified",
              "unavailable",
              true,
          );
}

function resolvePendingPromotionGrant(
    assetsRoot: string,
    assetId: UuidV4,
    pendingVersionId: UuidV4,
    target: PromotionGrantTarget,
    pendingGrant: PromotionGrantV1 | undefined,
    currentVersionIds: UuidV4[],
): PromotionGrantV1 | null {
    if (pendingGrant !== undefined) {
        validatePromotionGrantForPendingVersion(pendingGrant, assetId, pendingVersionId);
        if (stableStringify(pendingGrant.target) !== stableStringify(target)) {
            throw new RenderSelectionFailure(
                "render.promotion_grant_target_mismatch",
                "pending Version promotion grant targets another consumer",
                "conflict",
                true,
            );
        }
        return pendingGrant;
    }
    const matches = listPromotionGrantAuthorities(assetsRoot, assetId).filter(
        (grant) =>
            grant.grantState === "active" &&
            grant.subject.subjectKind === "asset_all_versions" &&
            currentVersionIds.includes(grant.subject.activationVersionId) &&
            stableStringify(grant.target) === stableStringify(target),
    );
    if (matches.length > 1) {
        throw new RenderSelectionFailure(
            "render.promotion_authority_ambiguous",
            "multiple active all-Version grants cover the pending Version",
            "conflict",
            true,
        );
    }
    return matches[0] ?? null;
}

function resolveImportedPromotionSafety(
    configuration: Pick<PromotionAuthorizationConfiguration, "assetsRoot" | "dialectRegistry">,
    closure: VersionAuthorityClosureV1,
): "default_promotable" | "requires_user_confirmation" | null {
    const resolved = resolveVersionSourcePromotionSafety(closure, (assetId, versionId) =>
        readVersionAuthority(configuration.assetsRoot, assetId, versionId, configuration.dialectRegistry),
    );
    if (resolved.status === "broken") {
        throw new RenderSelectionFailure("render.origin_lineage_broken", resolved.message);
    }
    return resolved.promotionSafety;
}

/** Core-owned target identity shared by render selection and reverse-accept promotion. */
export function promotionTargetForDeployment(deployment: RenderDeploymentInput): PromotionGrantTarget {
    return deployment.projectId === ""
        ? {
              targetKind: "global_target",
              targetAuthorityFingerprint: computeGlobalPromotionTargetAuthorityFingerprint({
                  platform: deployment.platform,
                  platformInstanceId: deployment.platformInstanceId,
                  targetRootPath: deployment.targetRootPath,
                  consumerAgentRuntimeIds: deployment.consumerAgentRuntimeIds,
              }),
          }
        : { targetKind: "project", projectId: deployment.projectId };
}

function projectionMatchesClosure(asset: RenderDeploymentInput["assets"][number], closure: VersionAuthorityClosureV1): boolean {
    const manifest = closure.manifest;
    return (
        asset.version.ref.assetId === manifest.assetId &&
        asset.version.ref.versionId === manifest.versionId &&
        asset.version.versionFingerprint === manifest.fingerprint &&
        asset.version.versionCanonicalContentFingerprint === manifest.versionCanonicalContentFingerprint &&
        asset.version.status === manifest.status &&
        stableStringify(asset.version.canonical) === stableStringify({ kind: manifest.kind, typeData: manifest.typeData }) &&
        stableStringify(asset.version.files) === stableStringify(closure.files)
    );
}
