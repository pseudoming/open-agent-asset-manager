import * as crypto from "node:crypto";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { buildPromotionGrantAuthority } from "../catalog/promotion-grant-store";
import {
    projectAppendedAssetManifestAuthority,
    readAssetManifestAuthority,
    validatePendingAssetVersionAuthority,
} from "../catalog/version-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { PromotionGrantV1, VersionOriginAuthorityV1 } from "../contracts/persistence";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { RenderDeploymentInput } from "../contracts/render";
import type { CommitRenderedTargetAcceptInput, PrepareRenderedTargetAcceptInput } from "../contracts/reverse";
import type { DeploymentPayloadInput } from "../deployment/deployment-payload-store";
import type { PreparedDeploymentSuccessAuthorityV1 } from "../deployment/deployment-state-authority";
import type { DeploymentSuccessCommitInputV1 } from "../deployment/deployment-state-ops";
import { assertAuthorityLockLease } from "../foundation/authority-locks";
import {
    computeAppliedInputsSnapshotFingerprint,
    computeAppliedRenderSnapshotFingerprint,
    computeAssetManifestFileFingerprint,
    computeDeploymentFileBaselineSetFingerprint,
    computePostAssetManifestAuthoritySetFingerprint,
    computePreCommitDatabaseStateFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { computePhysicalClosureKeys } from "../foundation/physical-path-locks";
import {
    hasExactKeys,
    isCanonicalRelativePath,
    isCanonicalTargetRootPath,
    isSha256Digest,
    isStrictObject,
    isUuidV4,
} from "../foundation/validators";
import { validateAppliedInputsSnapshot, validateAppliedRenderSnapshot } from "../render/deployment-render-authority";
import { promotionTargetForDeployment } from "../render/render-promotion-authorization";
import {
    type AssetFilesystemCommitReceiptV1,
    buildAssetFilesystemCommitReceipt,
    buildClaimedRenderedTargetCommitIntent,
    type ClaimedRenderedTargetCommitIntent,
    type PreparedRenderedTargetAccept,
    type ReverseAcceptRenderAnalysisValidator,
    type StagedVersionPromotionPublicationV1,
} from "./reverse-accept-marker";

import type {
    FreshReverseAcceptCommitDraft,
    FreshReverseAcceptPreparationDraft,
    ResolveFreshReverseAcceptCommitInput,
    ReverseAcceptServiceConfiguration,
} from "./reverse-accept-service-model";
import {
    compareUtf8Bytes,
    invalidCommitDraft,
    isSafeNonNegativeInteger,
    normalizeManifestAuthorities,
    ReverseAcceptResolverFailure,
    ReverseAcceptServiceFailure,
    renderProjectionMatchesVersion,
    requireExactValue,
    validateOriginDraft,
} from "./reverse-accept-service-shared";

export function normalizeAndValidateDraft(
    value: FreshReverseAcceptPreparationDraft,
    input: PrepareRenderedTargetAcceptInput,
    stagedVersionId: UuidV4,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
): FreshReverseAcceptPreparationDraft {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "deploymentAuthorityFingerprint",
            "assetManifestAuthorities",
            "inspectionScopeFingerprint",
            "inspectionResultFingerprint",
            "stagedAssetId",
            "stagedVersionFingerprint",
            "stagedVersionOriginDraft",
            "promotionState",
            "renderAnalysis",
        ])
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept resolver returned a non-object draft",
            "invalid_schema",
        );
    }
    for (const key of [
        "deploymentAuthorityFingerprint",
        "inspectionScopeFingerprint",
        "inspectionResultFingerprint",
        "stagedVersionFingerprint",
    ] as const) {
        if (!isSha256Digest(value[key])) {
            throw new ReverseAcceptServiceFailure(
                "reverse_accept.invalid_draft",
                `fresh reverse-accept draft ${key} is invalid`,
                "invalid_schema",
            );
        }
    }
    if (value.inspectionResultFingerprint !== input.inspectionResultFingerprint) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.inspection_stale",
            "fresh reverse-accept draft does not match the requested inspection result",
            "conflict",
        );
    }
    if (!isUuidV4(value.stagedAssetId)) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept draft stagedAssetId is invalid",
            "invalid_schema",
        );
    }
    if (value.promotionState !== "already_authorized" && value.promotionState !== "user_confirmation_required") {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept draft promotionState is invalid",
            "invalid_schema",
        );
    }
    const authorities = normalizeManifestAuthorities(value.assetManifestAuthorities);
    if (!authorities.some((item) => item.assetId === value.stagedAssetId)) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept staged Asset is outside the authority set",
            "invalid_schema",
        );
    }
    validateOriginDraft(value.stagedVersionOriginDraft);
    if (stagedVersionId === value.stagedVersionOriginDraft.previousVersionId) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.uuid_collision",
            "Core identity allocator reused the previous Version ID for the staged Version",
            "internal_error",
        );
    }
    if (value.stagedVersionOriginDraft.promotionRequirement === "not_required" && value.promotionState !== "already_authorized") {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "a Version origin with no promotion requirement cannot require user confirmation",
            "invalid_schema",
        );
    }
    renderAnalysisValidator.validate(value.renderAnalysis);
    return { ...structuredClone(value), assetManifestAuthorities: authorities };
}

export interface NormalizedFreshReverseAcceptCommitDraft extends FreshReverseAcceptCommitDraft {
    stagedPromotionPublication: StagedVersionPromotionPublicationV1;
}

export interface CommitEvidence {
    intent: ClaimedRenderedTargetCommitIntent;
    expectedFilesystemReceipt: AssetFilesystemCommitReceiptV1;
}

export async function resolveCommitDraft(
    configuration: Readonly<ReverseAcceptServiceConfiguration>,
    input: ResolveFreshReverseAcceptCommitInput,
): Promise<FreshReverseAcceptCommitDraft> {
    assertAuthorityLockLease(
        input.assetAuthorityLeaseProof,
        configuration.authorityLocksRoot,
        "assets",
        input.preparation.identity.assetIds,
    );
    assertAuthorityLockLease(input.settingsAuthorityLeaseProof, configuration.authorityLocksRoot, "settings", ["settings"]);
    const result = await configuration.resolveFreshCommit({
        request: structuredClone(input.request),
        preparation: structuredClone(input.preparation),
        stagedVersionOriginAuthority: structuredClone(input.stagedVersionOriginAuthority),
        promotionGrantId: input.promotionGrantId,
        assetAuthorityLeaseProof: input.assetAuthorityLeaseProof,
        settingsAuthorityLeaseProof: input.settingsAuthorityLeaseProof,
    });
    assertAuthorityLockLease(
        input.assetAuthorityLeaseProof,
        configuration.authorityLocksRoot,
        "assets",
        input.preparation.identity.assetIds,
    );
    assertAuthorityLockLease(input.settingsAuthorityLeaseProof, configuration.authorityLocksRoot, "settings", ["settings"]);
    if (result.status !== "complete") {
        throw new ReverseAcceptResolverFailure(
            "reverse_accept.fresh_commit_unavailable",
            "fresh reverse-accept analysis/materialization/compile did not complete",
            result.diagnostics,
        );
    }
    return structuredClone(result.value);
}

export function normalizeAndValidateCommitDraft(input: {
    draft: FreshReverseAcceptCommitDraft;
    prepared: PreparedRenderedTargetAccept;
    input: CommitRenderedTargetAcceptInput;
    origin: Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>;
    promotionGrantId: UuidV4 | "";
    assetsRoot: string;
    dialectRegistry: VersionDialectRegistryV1;
}): NormalizedFreshReverseAcceptCommitDraft {
    const draft = structuredClone(input.draft);
    if (
        !hasExactKeys(draft, [
            "deploymentAuthorityFingerprint",
            "assetManifestAuthorities",
            "inspectionScopeFingerprint",
            "inspectionResultFingerprint",
            "deployment",
            "renderAnalysis",
            "selectionFingerprint",
            "compilationFingerprint",
            "stagedVersion",
            "deploymentPayloads",
            "successCommit",
        ])
    ) {
        throw invalidCommitDraft("fresh commit draft must be one exact object");
    }
    for (const key of [
        "deploymentAuthorityFingerprint",
        "inspectionScopeFingerprint",
        "inspectionResultFingerprint",
        "selectionFingerprint",
        "compilationFingerprint",
    ] as const) {
        if (!isSha256Digest(draft[key])) {
            throw invalidCommitDraft(`fresh commit draft ${key} is invalid`);
        }
    }
    const authorities = normalizeManifestAuthorities(draft.assetManifestAuthorities);
    requireExactValue(authorities, input.prepared.assetManifestAuthorities, "fresh commit Asset manifest authority set");
    if (
        draft.deploymentAuthorityFingerprint !== input.prepared.deploymentAuthorityFingerprint ||
        draft.inspectionScopeFingerprint !== input.prepared.inspectionScopeFingerprint ||
        draft.inspectionResultFingerprint !== input.prepared.inspectionResultFingerprint
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.preparation_stale",
            "fresh reverse-accept authority no longer matches its preparation",
            "conflict",
            true,
        );
    }
    if (
        !isStrictObject(draft.deployment) ||
        draft.deployment.schemaVersion !== 1 ||
        draft.deployment.deploymentId !== input.prepared.identity.deploymentId ||
        draft.deployment.renderInputFingerprint !== input.prepared.renderAnalysis.renderInputFingerprint ||
        draft.deployment.renderInputFingerprint !== input.input.renderSelectionRequest.renderInputFingerprint
    ) {
        throw invalidCommitDraft("fresh render input does not bind the prepared Deployment and selection request");
    }
    requireExactValue(draft.renderAnalysis, input.prepared.renderAnalysis, "fresh render analysis");
    const deploymentAssetIds = draft.deployment.assets.map((asset) => asset.version.ref.assetId).sort(compareUtf8Bytes);
    if (
        new Set(deploymentAssetIds).size !== deploymentAssetIds.length ||
        stableStringify(deploymentAssetIds) !== stableStringify(input.prepared.identity.assetIds)
    ) {
        throw invalidCommitDraft("fresh Deployment assets do not cover the prepared Asset lock set exactly");
    }
    const stagedProjection = draft.deployment.assets.find((asset) => asset.version.ref.assetId === input.prepared.stagedAssetId);
    if (stagedProjection === undefined || !renderProjectionMatchesVersion(stagedProjection, draft.stagedVersion)) {
        throw invalidCommitDraft("fresh Deployment does not select the exact staged Version closure");
    }
    if (
        draft.stagedVersion.manifest.assetId !== input.prepared.stagedAssetId ||
        draft.stagedVersion.manifest.versionId !== input.prepared.stagedVersionId ||
        draft.stagedVersion.manifest.fingerprint !== input.prepared.stagedVersionFingerprint ||
        stableStringify(draft.stagedVersion.manifest.originAuthority) !== stableStringify(input.origin)
    ) {
        throw invalidCommitDraft("staged Version does not extend the prepared reverse identity");
    }
    validatePendingAssetVersionAuthority({
        assetsRoot: input.assetsRoot,
        version: draft.stagedVersion,
        dialectRegistry: input.dialectRegistry,
    });
    validateAppliedInputsSnapshot(draft.successCommit.appliedInputsSnapshot);
    validateAppliedRenderSnapshot(draft.successCommit.appliedRenderSnapshot);
    draft.deploymentPayloads = normalizeAndValidateDeploymentPayloads(draft.deploymentPayloads, draft.successCommit);
    if (
        draft.successCommit.deploymentId !== input.prepared.identity.deploymentId ||
        draft.successCommit.transactionId !== input.prepared.identity.commitTransactionId ||
        draft.successCommit.now !== input.origin.createdAt ||
        draft.successCommit.appliedRenderSnapshot.renderInputFingerprint !== draft.deployment.renderInputFingerprint ||
        draft.successCommit.appliedRenderSnapshot.selectionFingerprint !== draft.selectionFingerprint ||
        draft.successCommit.appliedRenderSnapshot.compilationFingerprint !== draft.compilationFingerprint
    ) {
        throw invalidCommitDraft("fresh success authority does not join the compiled render");
    }
    const expectedInputs = {
        schemaVersion: 1 as const,
        deploymentId: draft.deployment.deploymentId,
        consumerAgentRuntimeIds: draft.deployment.consumerAgentRuntimeIds,
        assets: draft.deployment.assets.map((asset) => ({
            assetId: asset.version.ref.assetId,
            versionId: asset.version.ref.versionId,
            allowIncomplete: asset.allowIncomplete,
        })),
    };
    requireExactValue(draft.successCommit.appliedInputsSnapshot, expectedInputs, "fresh AppliedInputsSnapshot");
    const stagedPromotionPublication = buildStagedPromotionPublication({
        request: input.input,
        origin: input.origin,
        promotionGrantId: input.promotionGrantId,
        deployment: draft.deployment,
    });
    requireExactPromotionAuthorization(
        draft.successCommit.appliedRenderSnapshot,
        input.origin,
        stagedPromotionPublication,
        promotionTargetForDeployment(draft.deployment),
    );
    return {
        ...draft,
        assetManifestAuthorities: authorities,
        stagedPromotionPublication,
    };
}

export function buildStagedPromotionPublication(input: {
    request: CommitRenderedTargetAcceptInput;
    origin: Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>;
    promotionGrantId: UuidV4 | "";
    deployment: RenderDeploymentInput;
}): StagedVersionPromotionPublicationV1 {
    if (input.request.newVersionPromotion.promotionAction === "use_existing_authority") {
        return { publicationState: "not_created" };
    }
    if (input.origin.promotionRequirement !== "requires_current_authorization") {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.promotion_choice_invalid",
            "a staged Version grant is valid only for an origin requiring current authorization",
            "invalid_schema",
        );
    }
    return {
        publicationState: "version_target_grant",
        promotionGrant: buildPromotionGrantAuthority({
            promotionGrantId: input.promotionGrantId,
            subject: {
                subjectKind: "asset_version",
                assetId: input.origin.assetId,
                versionId: input.origin.versionId,
            },
            target: promotionTargetForDeployment(input.deployment),
            userActionEvidenceId: input.origin.userActionEvidenceId,
            updatedAt: input.origin.createdAt,
        }),
    };
}

export function requireExactPromotionAuthorization(
    snapshot: DeploymentSuccessCommitInputV1["appliedRenderSnapshot"],
    origin: Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>,
    publication: StagedVersionPromotionPublicationV1,
    target: PromotionGrantV1["target"],
): void {
    const matches = snapshot.promotionAuthorizations.filter(
        (item) => item.assetId === origin.assetId && item.versionId === origin.versionId,
    );
    if (matches.length !== 1) {
        throw invalidCommitDraft("fresh render selection must resolve staged Version promotion exactly once");
    }
    const authorization = matches[0] as (typeof matches)[number];
    if (
        stableStringify(authorization.target) !== stableStringify(target) ||
        authorization.versionOriginAuthorityFingerprint !== origin.authorityFingerprint
    ) {
        throw invalidCommitDraft("fresh promotion authorization targets another authority");
    }
    if (origin.promotionRequirement === "not_required") {
        if (publication.publicationState !== "not_created" || authorization.promotionAuthorizationState !== "not_required") {
            throw invalidCommitDraft("non-restricted staged Version gained a promotion grant");
        }
        return;
    }
    if (authorization.promotionAuthorizationState !== "authorized") {
        throw invalidCommitDraft("restricted staged Version lacks current promotion authority");
    }
    if (publication.publicationState === "version_target_grant") {
        const grant = publication.promotionGrant;
        if (
            authorization.authorizationSource !== "version_target_grant" ||
            authorization.authorityId !== grant.promotionGrantId ||
            authorization.authorityRevision !== grant.revision ||
            authorization.authorityFingerprint !== grant.grantFingerprint
        ) {
            throw invalidCommitDraft("fresh selection did not consume the staged promotion grant");
        }
        return;
    }
    if (authorization.authorizationSource === "version_target_grant") {
        throw invalidCommitDraft("an unpersisted staged Version grant was treated as existing");
    }
}

export function buildCommitEvidence(input: {
    prepared: PreparedRenderedTargetAccept;
    normalized: NormalizedFreshReverseAcceptCommitDraft;
    preparedDatabaseAuthority: PreparedDeploymentSuccessAuthorityV1;
    assetsRoot: string;
}): CommitEvidence {
    const stagedAsset = readAssetManifestAuthority(input.assetsRoot, input.prepared.stagedAssetId);
    if (stagedAsset === null) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.asset_authority_missing",
            "staged Asset authority disappeared before claim",
            "conflict",
            true,
        );
    }
    const projected = projectAppendedAssetManifestAuthority({
        assetsRoot: input.assetsRoot,
        current: stagedAsset.manifest,
        stagedVersion: input.normalized.stagedVersion.manifest,
    });
    const stagedAssetManifestFingerprint = computeAssetManifestFileFingerprint(projected.manifest);
    const postAuthorities = input.prepared.assetManifestAuthorities.map((authority) =>
        authority.assetId === input.prepared.stagedAssetId
            ? {
                  assetId: authority.assetId,
                  assetManifestAuthorityFingerprint: projected.authority.assetManifestAuthorityFingerprint,
              }
            : authority,
    );
    const expectedPostAssetManifestAuthoritySetFingerprint = computePostAssetManifestAuthoritySetFingerprint(postAuthorities);
    const expectedFilesystemReceipt = buildAssetFilesystemCommitReceipt({
        schemaVersion: 1,
        preparationIdentityFingerprint: input.prepared.identity.preparationIdentityFingerprint,
        stagedAssetId: input.prepared.stagedAssetId,
        stagedVersionId: input.prepared.stagedVersionId,
        stagedVersionFingerprint: input.prepared.stagedVersionFingerprint,
        stagedVersionOriginAuthorityFingerprint: input.normalized.stagedVersion.manifest.originAuthority.authorityFingerprint,
        stagedPromotionPublication: input.normalized.stagedPromotionPublication,
        stagedAssetManifestFingerprint,
        postAssetManifestAuthoritySetFingerprint: expectedPostAssetManifestAuthoritySetFingerprint,
    });
    const preStateFingerprint = computePreCommitDatabaseStateFingerprint(input.preparedDatabaseAuthority.preCommitDatabaseState);
    const appliedInputsSnapshotFingerprint = computeAppliedInputsSnapshotFingerprint(
        input.normalized.successCommit.appliedInputsSnapshot,
    );
    const appliedRenderSnapshotFingerprint = computeAppliedRenderSnapshotFingerprint(
        input.normalized.successCommit.appliedRenderSnapshot,
    );
    const deploymentFileBaselineSetFingerprint = computeDeploymentFileBaselineSetFingerprint(
        input.preparedDatabaseAuthority.expectedSuccessPostcondition,
    );
    const expectedReceipt = input.preparedDatabaseAuthority.commitReceipt;
    if (
        expectedReceipt.preCommitDatabaseStateFingerprint !== preStateFingerprint ||
        expectedReceipt.appliedInputsSnapshotFingerprint !== appliedInputsSnapshotFingerprint ||
        expectedReceipt.appliedRenderSnapshotFingerprint !== appliedRenderSnapshotFingerprint ||
        expectedReceipt.deploymentFileBaselineSetFingerprint !== deploymentFileBaselineSetFingerprint ||
        expectedReceipt.deploymentId !== input.prepared.identity.deploymentId ||
        expectedReceipt.commitTransactionId !== input.prepared.identity.commitTransactionId
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.database_proof_mismatch",
            "prepared DB proof does not join the reverse-accept identity",
            "internal_error",
        );
    }
    const intent = buildClaimedRenderedTargetCommitIntent({
        preparationIdentityFingerprint: input.prepared.identity.preparationIdentityFingerprint,
        claimedPreparationRevision: input.prepared.preparationRevision,
        deploymentAuthorityFingerprint: input.prepared.deploymentAuthorityFingerprint,
        assetManifestAuthorities: input.prepared.assetManifestAuthorities,
        assetManifestAuthoritySetFingerprint: input.prepared.assetManifestAuthoritySetFingerprint,
        inspectionScopeFingerprint: input.prepared.inspectionScopeFingerprint,
        inspectionResultFingerprint: input.prepared.inspectionResultFingerprint,
        stagedAssetId: input.prepared.stagedAssetId,
        stagedVersionId: input.prepared.stagedVersionId,
        stagedVersionFingerprint: input.prepared.stagedVersionFingerprint,
        stagedVersionOriginAuthority: input.normalized.stagedVersion.manifest.originAuthority,
        stagedPromotionPublication: input.normalized.stagedPromotionPublication,
        stagedAssetManifestFingerprint,
        expectedPostAssetManifestAuthoritySetFingerprint,
        expectedAssetFilesystemReceiptFingerprint: expectedFilesystemReceipt.assetFilesystemReceiptFingerprint,
        freshRenderInputFingerprint: input.normalized.deployment.renderInputFingerprint,
        selectionFingerprint: input.normalized.selectionFingerprint,
        compilationFingerprint: input.normalized.compilationFingerprint,
        appliedInputsSnapshotFingerprint,
        appliedRenderSnapshotFingerprint,
        deploymentFileBaselineSetFingerprint,
        expectedSuccessPostcondition: input.preparedDatabaseAuthority.expectedSuccessPostcondition,
        preCommitDatabaseStateFingerprint: preStateFingerprint,
        expectedCommitReceiptFingerprint: expectedReceipt.commitReceiptFingerprint,
    });
    return { intent, expectedFilesystemReceipt };
}

export function normalizeAndValidateDeploymentPayloads(
    value: unknown,
    successCommit: DeploymentSuccessCommitInputV1,
): DeploymentPayloadInput[] {
    if (!Array.isArray(value)) {
        throw invalidCommitDraft("fresh commit deploymentPayloads must be an array");
    }
    const expectedByHash = new Map<Sha256Digest, { contentKind: DeploymentPayloadInput["contentKind"]; byteSize: number }>();
    for (const file of successCommit.verifiedActiveFiles) {
        const expected = file.appliedPayload;
        if (
            (expected.contentKind !== "text" && expected.contentKind !== "binary") ||
            !isSha256Digest(expected.contentHash) ||
            !isSafeNonNegativeInteger(expected.byteSize)
        ) {
            throw invalidCommitDraft("fresh active baseline has an invalid payload reference");
        }
        const prior = expectedByHash.get(expected.contentHash);
        const shape = { contentKind: expected.contentKind, byteSize: expected.byteSize };
        if (prior !== undefined && stableStringify(prior) !== stableStringify(shape)) {
            throw invalidCommitDraft("one Deployment payload hash has conflicting baseline metadata");
        }
        expectedByHash.set(expected.contentHash, shape);
    }
    for (const residual of successCommit.newlyRemoved) {
        const expected = residual.appliedPayload;
        if (
            (expected.contentKind !== "text" && expected.contentKind !== "binary") ||
            !isSha256Digest(expected.contentHash) ||
            !isSafeNonNegativeInteger(expected.byteSize)
        ) {
            throw invalidCommitDraft("fresh residual has an invalid payload reference");
        }
        const prior = expectedByHash.get(expected.contentHash);
        const shape = { contentKind: expected.contentKind, byteSize: expected.byteSize };
        if (prior !== undefined && stableStringify(prior) !== stableStringify(shape)) {
            throw invalidCommitDraft("one Deployment payload hash has conflicting success metadata");
        }
        expectedByHash.set(expected.contentHash, shape);
    }

    const actualByHash = new Map<Sha256Digest, DeploymentPayloadInput>();
    for (const candidate of value) {
        if (
            !isStrictObject(candidate) ||
            !hasExactKeys(candidate, ["contentKind", "contentHash", "bytes"]) ||
            (candidate.contentKind !== "text" && candidate.contentKind !== "binary") ||
            !isSha256Digest(candidate.contentHash) ||
            !(candidate.bytes instanceof Uint8Array)
        ) {
            throw invalidCommitDraft("fresh Deployment payload is not one exact payload object");
        }
        const contentHash = candidate.contentHash as Sha256Digest;
        if (actualByHash.has(contentHash)) {
            throw invalidCommitDraft("fresh Deployment payload hashes must be unique");
        }
        if (sha256Bytes(candidate.bytes) !== contentHash) {
            throw invalidCommitDraft("fresh Deployment payload bytes do not match their hash");
        }
        const expected = expectedByHash.get(contentHash);
        if (
            expected === undefined ||
            expected.contentKind !== candidate.contentKind ||
            expected.byteSize !== candidate.bytes.byteLength
        ) {
            throw invalidCommitDraft("fresh Deployment payload does not match a success authority reference");
        }
        actualByHash.set(contentHash, {
            contentKind: candidate.contentKind,
            contentHash,
            bytes: new Uint8Array(candidate.bytes),
        });
    }
    if (actualByHash.size !== expectedByHash.size) {
        throw invalidCommitDraft("fresh Deployment payloads do not cover every active baseline exactly");
    }
    return [...actualByHash.values()].sort((left, right) => compareUtf8Bytes(left.contentHash, right.contentHash));
}

export function physicalKeysForCommit(draft: FreshReverseAcceptCommitDraft): string[] {
    if (!isStrictObject(draft) || !isStrictObject(draft.deployment)) {
        throw invalidCommitDraft("fresh commit draft has no Deployment lock authority");
    }
    if (!isCanonicalTargetRootPath(draft.deployment.targetRootPath, draft.deployment.platform)) {
        throw invalidCommitDraft("fresh commit draft target root is not canonical absolute");
    }
    const snapshot = draft.successCommit?.appliedRenderSnapshot;
    if (
        !isStrictObject(draft.successCommit) ||
        !Array.isArray(draft.successCommit.verifiedActiveFiles) ||
        !Array.isArray(draft.successCommit.newlyRemoved) ||
        !isStrictObject(snapshot) ||
        snapshot.snapshotState !== "applied"
    ) {
        throw invalidCommitDraft("fresh commit draft has no AppliedRenderSnapshot lock closure");
    }
    try {
        validateAppliedRenderSnapshot(snapshot);
    } catch {
        throw invalidCommitDraft("fresh commit draft has an invalid AppliedRenderSnapshot lock closure");
    }
    const boundaries = snapshot.outputUnits.flatMap((unit) =>
        unit.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
    );
    const filePaths = [
        ...draft.successCommit.verifiedActiveFiles.map((file) => file.verified.relativePath),
        ...draft.successCommit.newlyRemoved.map((residual) => residual.relativePath),
    ];
    if ([...boundaries, ...filePaths].some((relativePath) => !isCanonicalRelativePath(relativePath))) {
        throw invalidCommitDraft("fresh commit draft lock closure contains an unsafe path");
    }
    return computePhysicalClosureKeys(draft.deployment.platform, draft.deployment.targetRootPath, [
        { relativePath: "", entryKind: "directory" },
        ...boundaries.map((relativePath) => ({
            relativePath,
            entryKind: "directory" as const,
        })),
        ...filePaths.map((relativePath) => ({
            relativePath,
            entryKind: "file" as const,
            containingDirectoryBoundaries: boundaries.filter(
                (boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`),
            ),
        })),
    ]);
}

export function commitDraftFingerprint(draft: FreshReverseAcceptCommitDraft): string {
    return crypto.createHash("sha256").update(stableStringify(draft), "utf-8").digest("hex");
}
